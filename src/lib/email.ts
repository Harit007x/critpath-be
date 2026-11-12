import { Resend } from "resend";
import { notifyOps } from "./discord";

// Built lazily: dotenv-flow loads env in index.ts after imports are evaluated.
let client: Resend | null | undefined;

function getClient(): Resend | null {
  if (client === undefined) {
    const key = process.env.RESEND_API_KEY;
    client = key ? new Resend(key) : null;
  }
  return client;
}

/**
 * Sends one transactional email through Resend. Without RESEND_API_KEY (the normal
 * local setup) the email is printed to the server console instead, so flows such
 * as password reset still work on a single machine. Build the content with
 * lib/emails.ts, which makes the HTML and its plain-text part.
 */
export async function sendEmail(options: {
  to: string;
  subject: string;
  html: string;
  text: string;
}): Promise<void> {
  const resend = getClient();
  if (!resend) {
    // Deployed, this means verification links only reach the log: nobody new can get in.
    if (process.env.NODE_ENV === "production")
      void notifyOps(
        "email-unset",
        "Emails are not being sent",
        "RESEND_API_KEY is not set on the API, so verification and password-reset links only reach its log."
      );
    console.log(
      `\n[Email] To: ${options.to}\n[Email] Subject: ${options.subject}\n[Email] Body:\n${options.text}\n`
    );
    return;
  }

  const from = process.env.RESEND_FROM_EMAIL || "CritPath <onboarding@resend.dev>";
  const { error } = await resend.emails.send({
    from,
    to: options.to,
    subject: options.subject,
    html: options.html,
    text: options.text,
  });
  if (error) throw new Error(error.message);
}
