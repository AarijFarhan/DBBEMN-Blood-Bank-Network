import nodemailer from "nodemailer";

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.warn("[EMAIL] SMTP not configured. Emails will be logged only.");
    return null;
  }

  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || "587"),
    secure: process.env.SMTP_SECURE === "true",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
  return transporter;
}

export async function sendEmail({ to, subject, text, html }) {
  const transport = getTransporter();
  
  if (!transport) {
    console.log("[EMAIL SKIPPED - NOT CONFIGURED]", { to, subject });
    return { success: true, skipped: true };
  }

  try {
    const info = await transport.sendMail({
      from: `"${process.env.SMTP_FROM_NAME || "DBBEMN"}" <${process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER}>`,
      to,
      subject,
      text,
      html,
    });
    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error("[EMAIL ERROR]", error);
    throw error;
  }
}

export async function sendPasswordResetEmail(email, resetToken, resetLink) {
  const link = resetLink || `${process.env.FRONTEND_URL || "http://localhost:5173"}/reset-password?token=${resetToken}`;
  const subject = "Password Reset Request - DBBEMN Blood Bank Network";
  const html = `
    <h2>Password Reset Request</h2>
    <p>You requested a password reset for your DBBEMN account.</p>
    <p>Click the link below to reset your password:</p>
    <p><a href="${link}">Reset Password</a></p>
    <p>This link will expire in 1 hour.</p>
    <p>If you didn't request this, please ignore this email.</p>
    <hr>
    <p><small>DBBEMN Blood Bank Network</small></p>
  `;
  const text = `Password Reset Request\n\nYou requested a password reset. Click here: ${link}\n\nLink expires in 1 hour. If you didn't request this, ignore this email.`;
  
  return sendEmail({ to: email, subject, text, html });
}

export async function sendDonorRequestNotification(email, requestDetails) {
  const subject = "Donor Request Notification - DBBEMN";
  const html = `
    <h2>Donor Request Update</h2>
    <p>${requestDetails.message}</p>
    <hr>
    <p><small>DBBEMN Blood Bank Network</small></p>
  `;
  const text = `${requestDetails.message}\n\nDBBEMN Blood Bank Network`;
  
  return sendEmail({ to: email, subject, text, html });
}

export async function sendReservationConfirmation(email, reservationDetails) {
  const subject = "Reservation Confirmation - DBBEMN";
  const html = `
    <h2>Reservation Confirmation</h2>
    <p>Your blood unit reservation has been confirmed.</p>
    <p><strong>Reservation ID:</strong> ${reservationDetails.reservationId}</p>
    <p><strong>Blood Group:</strong> ${reservationDetails.bloodGroup}</p>
    <p><strong>Expiry:</strong> ${reservationDetails.expiryDate}</p>
    <hr>
    <p><small>DBBEMN Blood Bank Network</small></p>
  `;
  const text = `Reservation confirmed. ID: ${reservationDetails.reservationId}, Blood: ${reservationDetails.bloodGroup}`;
  
  return sendEmail({ to: email, subject, text, html });
}
