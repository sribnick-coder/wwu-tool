const { google } = require('googleapis');
const supabase = require('./db');

const SETTING_KEY = 'google_oauth_token';

function getOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

async function loadToken() {
  try {
    const { data } = await supabase
      .from('app_settings')
      .select('value')
      .eq('key', SETTING_KEY)
      .single();
    return data?.value || null;
  } catch {
    return null;
  }
}

async function saveToken(token) {
  await supabase
    .from('app_settings')
    .upsert({ key: SETTING_KEY, value: token }, { onConflict: 'key' });
}

async function clearToken() {
  await supabase.from('app_settings').delete().eq('key', SETTING_KEY);
}

function getAuthUrl() {
  const oauth2Client = getOAuthClient();
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/drive.file'],
    prompt: 'consent',
  });
}

async function exchangeCode(code) {
  const oauth2Client = getOAuthClient();
  const { tokens } = await oauth2Client.getToken(code);
  await saveToken(tokens);
  return tokens;
}

async function getAuthorizedClient() {
  const token = await loadToken();
  if (!token) throw new Error('NOT_AUTHORIZED');

  const oauth2Client = getOAuthClient();
  oauth2Client.setCredentials(token);

  // Refresh if expired
  if (token.expiry_date && token.expiry_date < Date.now() + 60000) {
    try {
      const { credentials } = await oauth2Client.refreshAccessToken();
      await saveToken(credentials);
      oauth2Client.setCredentials(credentials);
    } catch (err) {
      await clearToken();
      throw new Error('NOT_AUTHORIZED');
    }
  }

  return oauth2Client;
}

async function isAuthorized() {
  const token = await loadToken();
  return token !== null;
}

// Walk Google Drive folder path by name (supports shared/team drives)
async function resolveFolderPath(drive, pathParts, parentId = 'root') {
  let currentParent = parentId;

  for (const part of pathParts) {
    const res = await drive.files.list({
      q: `name = '${part.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and '${currentParent}' in parents and trashed = false`,
      fields: 'files(id, name)',
      pageSize: 10,
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      corpora: 'allDrives',
    });

    if (!res.data.files?.length) {
      throw new Error(`FOLDER_NOT_FOUND:${part}`);
    }

    currentParent = res.data.files[0].id;
  }

  return currentParent;
}

async function ensureYearFolder(drive, baseFolderId, year) {
  const res = await drive.files.list({
    q: `name = '${year}' and mimeType = 'application/vnd.google-apps.folder' and '${baseFolderId}' in parents and trashed = false`,
    fields: 'files(id)',
    includeItemsFromAllDrives: true,
    supportsAllDrives: true,
    corpora: 'allDrives',
  });

  if (res.data.files?.length) return res.data.files[0].id;

  const created = await drive.files.create({
    requestBody: {
      name: String(year),
      mimeType: 'application/vnd.google-apps.folder',
      parents: [baseFolderId],
    },
    fields: 'id',
    supportsAllDrives: true,
  });

  return created.data.id;
}

function formatDocBody(draft, entries) {
  const sections = {
    in_this_week: entries.filter(e => e.section === 'in_this_week').sort((a, b) => a.position - b.position),
    considered: entries.filter(e => e.section === 'considered').sort((a, b) => a.position - b.position),
    save_for_future: entries.filter(e => e.section === 'save_for_future').sort((a, b) => a.position - b.position),
  };

  const footer = `Thank you for reading the A-Street Weekly Wrap-Up, a collection of notable news, announcements, and opinions gathered from a broad scan of PreK-12 media. We curate the selection based on what we think might be most relevant, thought-provoking, and helpful to the A-Street community. We endeavor to include a variety of perspectives and views beyond just our own. Questions, comments, or suggestions? We'd love to hear from you at hello@astreet.com.\n\nWas this forwarded to you? Please subscribe!`;

  // Build requests array for Google Docs batchUpdate
  const requests = [];
  let cursor = 1;

  function insertText(text, bold = false, fontSize = 11, color = null) {
    requests.push({
      insertText: { location: { index: cursor }, text },
    });
    const textLen = text.length;
    const style = { bold, fontSize: { magnitude: fontSize, unit: 'PT' } };
    if (color) style.foregroundColor = { color: { rgbColor: color } };
    requests.push({
      updateTextStyle: {
        range: { startIndex: cursor, endIndex: cursor + textLen },
        textStyle: style,
        fields: 'bold,fontSize' + (color ? ',foregroundColor' : ''),
      },
    });
    cursor += textLen;
  }

  // Section: In this week
  insertText('In this week\n', true, 14, { red: 0.247, green: 0.698, blue: 0.310 });

  for (const entry of sections.in_this_week) {
    const line = `${entry.headline}: ${entry.summary || ''}\n\n`;
    insertText(line, false, 11);
  }

  // Footer
  insertText(footer + '\n\n', false, 10);

  // Section: Considered
  insertText('Considered (not included this week)\n', true, 14, { red: 0.247, green: 0.698, blue: 0.310 });
  for (const entry of sections.considered) {
    insertText(`${entry.headline}: ${entry.summary || ''}\n\n`, false, 10);
  }

  // Section: Save for future
  insertText('Save for future\n', true, 14, { red: 0.247, green: 0.698, blue: 0.310 });
  for (const entry of sections.save_for_future) {
    insertText(`${entry.headline}: ${entry.summary || ''}\n\n`, false, 10);
  }

  return requests;
}

async function createGoogleDoc(weekDate, entries) {
  const auth = await getAuthorizedClient();
  const drive = google.drive({ version: 'v3', auth });
  const docs = google.docs({ version: 'v1', auth });

  // Resolve target folder — env var takes priority over path traversal
  let folderId = process.env.GDRIVE_FOLDER_ID || null;

  if (!folderId) {
    const basePath = [
      'A-Street Workspace',
      'Internal Operations (Finance, HR, Legal, Internal Meetings, etc.)',
      'Weekly Wrap Up',
    ];
    const year = new Date(weekDate).getFullYear();
    try {
      const baseFolderId = await resolveFolderPath(drive, basePath);
      folderId = await ensureYearFolder(drive, baseFolderId, year);
    } catch (err) {
      if (err.message.startsWith('FOLDER_NOT_FOUND:')) {
        const missing = err.message.split(':')[1];
        throw new Error(
          `Google Drive folder not found: "${missing}". ` +
          `Set the GDRIVE_FOLDER_ID env var to the ID of the Weekly Wrap Up folder ` +
          `(copy it from the URL when you have that folder open in Drive).`
        );
      }
      throw err;
    }
  }

  // Format title
  const d = new Date(weekDate);
  const title = `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')} - WWU`;

  // Create the doc
  const docRes = await docs.documents.create({ requestBody: { title } });
  const docId = docRes.data.documentId;

  // Move to target folder (supportsAllDrives needed for shared drives)
  await drive.files.update({
    fileId: docId,
    addParents: folderId,
    removeParents: 'root',
    fields: 'id, parents',
    supportsAllDrives: true,
  });

  // Build and apply formatting
  const draft = { week_date: weekDate };
  const requests = formatDocBody(draft, entries);

  if (requests.length > 0) {
    await docs.documents.batchUpdate({
      documentId: docId,
      requestBody: { requests },
    });
  }

  // Share with reviewers
  const reviewerEmails = (process.env.REVIEWER_EMAILS || '').split(',').map(e => e.trim()).filter(Boolean);
  for (const email of reviewerEmails) {
    await drive.permissions.create({
      fileId: docId,
      requestBody: { type: 'user', role: 'commenter', emailAddress: email },
      sendNotificationEmail: true,
      supportsAllDrives: true,
    }).catch(err => console.warn(`Could not share with ${email}:`, err.message));
  }

  return `https://docs.google.com/document/d/${docId}/edit`;
}

module.exports = { getAuthUrl, exchangeCode, createGoogleDoc, isAuthorized };
