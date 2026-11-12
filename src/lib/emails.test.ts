import { describe, expect, it } from "vitest";
import {
  existingAccountEmail,
  resetPasswordEmail,
  verifyEmail,
  welcomeEmail,
} from "./emails";

const link = "https://app.thecritpath.com/api/auth/verify-email?token=abc&callbackURL=%2Fverify-email";

describe("emails", () => {
  it("puts the link in the button, the fallback line and the text part", () => {
    const email = verifyEmail(link);
    expect(email.subject).toBe("Verify your email for CritPath");
    const escaped = link.replace(/&/g, "&#38;");
    expect(email.html.split(`href="${escaped}"`)).toHaveLength(3);
    expect(email.text).toContain(`Verify email: ${link}`);
    expect(email.text).not.toMatch(/<[a-z]/);
  });

  it("escapes what people typed", () => {
    const email = welcomeEmail('<img src=x onerror="alert(1)"> Lovelace');
    expect(email.html).not.toContain("<img src=x");
    // The text part is not HTML: it keeps the name as typed.
    expect(email.text).toContain("Hi <img");
  });

  it("links to the web app at FRONTEND_URL", () => {
    const saved = process.env.FRONTEND_URL;
    process.env.FRONTEND_URL = "https://app.example.test/";
    try {
      const email = existingAccountEmail();
      expect(email.html).toContain('href="https://app.example.test/login"');
      expect(email.html).toContain('src="https://app.example.test/email/critpath-mark.png"');
    } finally {
      if (saved === undefined) delete process.env.FRONTEND_URL;
      else process.env.FRONTEND_URL = saved;
    }
    expect(resetPasswordEmail(link).text).toContain("1 hour");
  });

  it("welcomes by first name, or without one", () => {
    expect(welcomeEmail("Ada Lovelace").text).toContain("Hi Ada, your CritPath account is ready.");
    expect(welcomeEmail("  ").text).toContain("\n\nYour CritPath account is ready.");
    expect(welcomeEmail("<b>").html).not.toContain("<b>");
  });
});
