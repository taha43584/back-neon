import { describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import {
  storePasswordResetToken,
  consumePasswordResetToken,
  verifyUserPassword,
  BCRYPT_ROUNDS,
} from "./db";

describe("Native Auth & Password Security", () => {
  it("verifies bcrypt password hashes accurately", async () => {
    const rawPassword = "MonMotDePasseSecurise123!";
    const passwordHash = await bcrypt.hash(rawPassword, 10);

    const isValid = await verifyUserPassword({ passwordHash }, rawPassword);
    const isInvalid = await verifyUserPassword({ passwordHash }, "MauvaisMotDePasse");
    const isNullHash = await verifyUserPassword({ passwordHash: null }, rawPassword);

    expect(isValid).toBe(true);
    expect(isInvalid).toBe(false);
    expect(isNullHash).toBe(false);
  });

  it("returns false without throwing for accounts without a usable password, and hashes with cost 12", async () => {
    await expect(verifyUserPassword({ passwordHash: null }, "x")).resolves.toBe(false);
    await expect(verifyUserPassword({ passwordHash: "" }, "x")).resolves.toBe(false);
    await expect(verifyUserPassword({ passwordHash: "pas-un-hash-bcrypt" }, "x")).resolves.toBe(false);
    expect(BCRYPT_ROUNDS).toBe(12);
    expect(bcrypt.getRounds(await bcrypt.hash("x", BCRYPT_ROUNDS))).toBe(12);
  });

  it("stores and consumes password reset tokens (one-time usage)", () => {
    const userId = 42;
    const token = storePasswordResetToken(userId);

    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(20);

    // Première consommation : valide
    const consumedUserId = consumePasswordResetToken(token);
    expect(consumedUserId).toBe(userId);

    // Deuxième consommation : doit renvoyer null (token à usage unique)
    const replayUserId = consumePasswordResetToken(token);
    expect(replayUserId).toBeNull();
  });

  it("rejects unknown or expired reset tokens", () => {
    const invalidResult = consumePasswordResetToken("token-totalement-inconnu-12345");
    expect(invalidResult).toBeNull();
  });
});
