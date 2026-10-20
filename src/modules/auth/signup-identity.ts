import jwt from "jsonwebtoken";
import { env } from "../../config/env.js";
import { unauthorized } from "../../core/http/api-error.js";

export type SignupIdentity = { provider: "email"; email: string } | { provider: "mobile"; mobile: string };
const audience = "fundledger:onboarding-signup";
export function verifiedSignup(identity: SignupIdentity) {
  return { kind: "signup" as const, signup_needed: true, ...identity,
    signup_token: jwt.sign(identity, env.jwtSecret, { algorithm: "HS256", audience, expiresIn: "15m" }) };
}
export function readSignupIdentity(token: string): SignupIdentity {
  try {
    const value = jwt.verify(token, env.jwtSecret, { algorithms: ["HS256"], audience });
    if (typeof value !== "string") {
      if (value.provider === "email" && typeof value.email === "string") return { provider: "email", email: value.email };
      if (value.provider === "mobile" && typeof value.mobile === "string") return { provider: "mobile", mobile: value.mobile };
    }
  } catch { /* Expired or altered verification proof. */ }
  throw unauthorized("Your verification expired. Request a new code.");
}
