import { ENV } from "./_core/env";

// -----------------------------------------------------------------
// Graceful email sender using nodemailer.
// If SMTP is not configured the mail is only logged to console.
// -----------------------------------------------------------------

type Transporter = {
  sendMail(opts: {
    from: string;
    to: string;
    subject: string;
    html: string;
  }): Promise<unknown>;
};

let _transporter: Transporter | null = null;

async function getTransporter(): Promise<Transporter | null> {
  if (_transporter) return _transporter;
  if (!ENV.smtpHost) return null;

  try {
    const nodemailer = await import("nodemailer");
    _transporter = nodemailer.createTransport({
      host: ENV.smtpHost,
      port: ENV.smtpPort,
      secure: ENV.smtpPort === 465,
      auth: ENV.smtpUser
        ? { user: ENV.smtpUser, pass: ENV.smtpPass }
        : undefined,
    }) as unknown as Transporter;
    return _transporter;
  } catch (err) {
    console.warn("[Email] Failed to create transport:", err);
    return null;
  }
}

function welcomeHtml(name: string, email: string, password: string): string {
  return `
<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"><style>
  body { font-family: 'Georgia', serif; background: #fcfaf7; color: #302a26; margin: 0; padding: 0; }
  .container { max-width: 560px; margin: 40px auto; background: #fff; border-radius: 24px; padding: 40px; border: 1px solid #eadfd6; }
  h1 { font-size: 26px; margin: 0 0 8px; color: #302a26; }
  .eyebrow { font-size: 11px; letter-spacing: 0.2em; text-transform: uppercase; color: #b07855; margin-bottom: 16px; }
  .credentials { background: #fbf8f4; border-radius: 12px; padding: 20px; margin: 24px 0; border: 1px solid #eadfd6; }
  .credentials p { margin: 6px 0; font-size: 14px; }
  .credentials strong { color: #a16f50; }
  .cta { display: inline-block; margin-top: 24px; background: #302a26; color: #fff; text-decoration: none; padding: 12px 28px; border-radius: 100px; font-size: 14px; }
  .footer { margin-top: 32px; font-size: 12px; color: #9a8b81; }
</style></head>
<body>
  <div class="container">
    <p class="eyebrow">Elegance Deco</p>
    <h1>Bienvenue sur Elegance Deco</h1>
    <p style="font-size:15px;color:#6f6259;line-height:1.7">
      Votre compte a été créé par notre équipe. Voici vos identifiants de connexion :
    </p>
    <div class="credentials">
      <p><strong>Email :</strong> ${email}</p>
      <p><strong>Mot de passe :</strong> ${password}</p>
    </div>
    <p style="font-size:14px;color:#6f6259">
      Connectez-vous et changez votre mot de passe dès votre première connexion.
    </p>
    <a href="https://elegancedeco.tn/espace-client" class="cta">Accéder à mon espace</a>
    <div class="footer">
      <p>Elegance Deco — Marketplace tunisienne de décoration artisanale.</p>
      <p>Si vous n'êtes pas à l'origine de cette demande, ignorez cet email.</p>
    </div>
  </div>
</body>
</html>`;
}

function resetPasswordHtml(name: string, resetToken: string): string {
  return `
<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"><style>
  body { font-family: 'Georgia', serif; background: #fcfaf7; color: #302a26; margin: 0; padding: 0; }
  .container { max-width: 560px; margin: 40px auto; background: #fff; border-radius: 24px; padding: 40px; border: 1px solid #eadfd6; }
  .eyebrow { font-size: 11px; letter-spacing: 0.2em; text-transform: uppercase; color: #b07855; margin-bottom: 16px; }
  h1 { font-size: 26px; margin: 0 0 8px; }
  .token { background: #fbf8f4; border-radius: 12px; padding: 16px 20px; margin: 20px 0; font-family: monospace; font-size: 15px; border: 1px solid #eadfd6; color: #302a26; word-break: break-all; }
  .footer { margin-top: 32px; font-size: 12px; color: #9a8b81; }
</style></head>
<body>
  <div class="container">
    <p class="eyebrow">Elegance Deco</p>
    <h1>Réinitialisation du mot de passe</h1>
    <p style="font-size:15px;color:#6f6259;line-height:1.7">
      Bonjour ${name || ""},<br>
      Voici votre token de réinitialisation (valable 1 heure) :
    </p>
    <div class="token">${resetToken}</div>
    <p style="font-size:13px;color:#88796f">
      Utilisez ce token dans le formulaire de réinitialisation sur le site.
      Si vous n'avez pas demandé cette réinitialisation, ignorez cet email.
    </p>
    <div class="footer">Elegance Deco — Marketplace tunisienne de décoration.</div>
  </div>
</body>
</html>`;
}

export async function sendWelcomeEmail(
  to: string,
  name: string,
  password: string
): Promise<void> {
  const html = welcomeHtml(name, to, password);
  const subject = "Bienvenue sur Elegance Deco — vos identifiants";

  const transport = await getTransporter();
  if (!transport) {
    console.log(
      "[Email] SMTP non configuré — identifiants envoyés (log uniquement):",
      { to, subject, password }
    );
    return;
  }

  try {
    await transport.sendMail({ from: ENV.emailFrom, to, subject, html });
    console.log("[Email] Email de bienvenue envoyé à", to);
  } catch (err) {
    console.error("[Email] Échec envoi email de bienvenue:", err);
    // Non-fatal — le compte est créé même si l'email échoue
  }
}

export async function sendPasswordResetEmail(
  to: string,
  name: string,
  resetToken: string
): Promise<void> {
  const html = resetPasswordHtml(name, resetToken);
  const subject = "Elegance Deco — Réinitialisation de votre mot de passe";

  const transport = await getTransporter();
  if (!transport) {
    console.log("[Email] SMTP non configuré — token reset (log uniquement):", {
      to,
      resetToken,
    });
    return;
  }

  try {
    await transport.sendMail({ from: ENV.emailFrom, to, subject, html });
    console.log("[Email] Email reset envoyé à", to);
  } catch (err) {
    console.error("[Email] Échec envoi email reset:", err);
  }
}
