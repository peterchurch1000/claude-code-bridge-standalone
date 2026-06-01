const nodemailer = require('nodemailer');

let transporter;

function initTransporter() {
  transporter = nodemailer.createTransport({
    host: process.env.MAIL_HOST || 'mail.privateemail.com',
    port: parseInt(process.env.MAIL_PORT || '465'),
    secure: true,
    auth: {
      user: process.env.MAIL_USERNAME || 'peter.church@procyss-automation.com',
      pass: process.env.MAIL_PASSWORD || 'Church*2023'
    }
  });
}

async function sendPasswordResetEmail(email, resetToken, bridgeUrl) {
  if (!transporter) {
    initTransporter();
  }

  const resetLink = `${bridgeUrl}/auth/reset-password?token=${resetToken}`;
  const bridgeName = process.env.BRIDGE_NAME || 'Bridge';
  const fromEmail = process.env.MAIL_FROM_ADDRESS || 'noreply@procyss-automation.com';
  const fromName = process.env.MAIL_FROM_NAME || 'Bridge Authentication';

  const htmlContent = `
    <h2>Password Reset Request</h2>
    <p>You requested a password reset for your ${bridgeName} account.</p>
    <p>Click the link below to reset your password (valid for 1 hour):</p>
    <p><a href="${resetLink}">${resetLink}</a></p>
    <p>If you didn't request this, you can safely ignore this email.</p>
  `;

  const textContent = `
Password Reset Request

You requested a password reset for your ${bridgeName} account.

Click the link below to reset your password (valid for 1 hour):
${resetLink}

If you didn't request this, you can safely ignore this email.
  `;

  return transporter.sendMail({
    from: `${fromName} <${fromEmail}>`,
    to: email,
    subject: `Password Reset for ${bridgeName}`,
    text: textContent.trim(),
    html: htmlContent.trim()
  });
}

module.exports = {
  initTransporter,
  sendPasswordResetEmail
};
