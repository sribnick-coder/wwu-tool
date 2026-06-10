const { google } = require('googleapis');

const LOGIN_REDIRECT = process.env.GOOGLE_LOGIN_REDIRECT_URI || 'http://localhost:3000/auth/callback';

function getLoginClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    LOGIN_REDIRECT,
  );
}

function getLoginUrl() {
  const client = getLoginClient();
  return client.generateAuthUrl({
    access_type: 'online',
    scope: ['openid', 'email', 'profile'],
    prompt: 'select_account',
  });
}

async function exchangeLoginCode(code) {
  const client = getLoginClient();
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);
  const oauth2 = google.oauth2({ version: 'v2', auth: client });
  const { data } = await oauth2.userinfo.get();
  return {
    email: data.email,
    name: data.name || data.email.split('@')[0],
    picture: data.picture || null,
  };
}

function isAllowedUser(email) {
  if (!email) return false;
  // Explicit allowlist takes priority
  const allowedEmails = (process.env.ALLOWED_EMAILS || '').split(',').map(e => e.trim()).filter(Boolean);
  if (allowedEmails.length > 0 && allowedEmails.includes(email)) return true;
  // Domain allowlist
  const domains = (process.env.ALLOWED_DOMAINS || 'astreet.com').split(',').map(d => d.trim()).filter(Boolean);
  const domain = (email.split('@')[1] || '').toLowerCase();
  return domains.some(d => d.toLowerCase() === domain);
}

module.exports = { getLoginUrl, exchangeLoginCode, isAllowedUser };
