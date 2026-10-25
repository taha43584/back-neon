import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import { COOKIE_NAME } from "../shared/const";
import type { TrpcContext } from "./_core/context";
import { nanoid } from "nanoid";
import { getDb } from "./db";
import { users } from "../drizzle/schema";
import { eq } from "drizzle-orm";
import { sdk } from "./_core/sdk";

type CookieCall = {
  name: string;
  val?: string;
  options: Record<string, unknown>;
};

function createMockContext(cookieHeader = ""): {
  ctx: TrpcContext;
  setCookies: CookieCall[];
  clearedCookies: CookieCall[];
} {
  const setCookies: CookieCall[] = [];
  const clearedCookies: CookieCall[] = [];

  const req = {
    protocol: "https",
    headers: {
      cookie: cookieHeader,
    },
  } as unknown as TrpcContext["req"];

  const res = {
    cookie: (name: string, val: string, options: Record<string, unknown>) => {
      setCookies.push({ name, val, options });
    },
    clearCookie: (name: string, options: Record<string, unknown>) => {
      clearedCookies.push({ name, options });
    },
  } as unknown as TrpcContext["res"];

  const ctx: TrpcContext = {
    user: null,
    req,
    res,
  };

  return { ctx, setCookies, clearedCookies };
}

describe("Complete End-to-End Auth Workflow", () => {
  let isDbAvailable = false;

  beforeAll(async () => {
    try {
      const db = await getDb();
      if (db) {
        await db.select().from(users).limit(1);
        isDbAvailable = true;
      }
    } catch {
      isDbAvailable = false;
    }
  });

  const uniqueSuffix = nanoid(8).toLowerCase();
  // Domaine réservé aux tests (jamais un domaine réel)
  const testEmail = `test_flow_${uniqueSuffix}@elegancedeco.test`;
  const testPassword = "MonMotDePasseTest123!";
  const testName = "Testeur Elegance";
  const testPhone = "+216 20 999 888";
  let sessionCookieToken = "";

  it("1. Inscription (auth.register) creates user and sets session cookie", async (ctx) => {
    if (!isDbAvailable) {
      ctx.skip();
      return;
    }
    const { ctx: trpcCtx, setCookies } = createMockContext();
    const caller = appRouter.createCaller(trpcCtx);

    const result = await caller.auth.register({
      name: testName,
      email: testEmail,
      phone: testPhone,
      password: testPassword,
    });

    expect(result.success).toBe(true);
    expect(result.user.name).toBe(testName);
    expect(result.user.email).toBe(testEmail);
    expect(result.user.role).toBe("user");

    // Cookie de session
    expect(setCookies.length).toBeGreaterThanOrEqual(1);
    const authCookie = setCookies.find((c) => c.name === COOKIE_NAME);
    expect(authCookie).toBeDefined();
    expect(authCookie?.val).toBeDefined();
    sessionCookieToken = authCookie!.val!;
  });

  it("2. Refuses duplicate email registration", async (ctx) => {
    if (!isDbAvailable) {
      ctx.skip();
      return;
    }
    const { ctx: trpcCtx } = createMockContext();
    const caller = appRouter.createCaller(trpcCtx);

    await expect(
      caller.auth.register({
        name: "Autre Nom",
        email: testEmail,
        password: "AutrePassword123!",
      })
    ).rejects.toThrow("Un compte avec cet email existe déjà");
  });

  it("3. Mauvais mot de passe / mauvais email (auth.login)", async (ctx) => {
    if (!isDbAvailable) {
      ctx.skip();
      return;
    }
    const { ctx: trpcCtx } = createMockContext();
    const caller = appRouter.createCaller(trpcCtx);

    // Mauvais mot de passe
    await expect(
      caller.auth.login({
        email: testEmail,
        password: "MauvaisPassword999",
      })
    ).rejects.toThrow("Email ou mot de passe incorrect");

    // Email inexistant
    await expect(
      caller.auth.login({
        email: "email_inexistant_99999@domaine.tn",
        password: "NimporteQuoi123!",
      })
    ).rejects.toThrow("Email ou mot de passe incorrect");
  });

  it("4. Connexion avec compte valide (auth.login)", async (ctx) => {
    if (!isDbAvailable) {
      ctx.skip();
      return;
    }
    const { ctx: trpcCtx, setCookies } = createMockContext();
    const caller = appRouter.createCaller(trpcCtx);

    const result = await caller.auth.login({
      email: testEmail,
      password: testPassword,
    });

    expect(result.success).toBe(true);
    expect(result.user.email).toBe(testEmail);
    expect(setCookies.some((c) => c.name === COOKIE_NAME)).toBe(true);
  });

  it("5. Session persistence (auth.me avec token JWT)", async (ctx) => {
    if (!isDbAvailable) {
      ctx.skip();
      return;
    }
    // Simuler une requête avec le cookie de session envoyé
    const { ctx: trpcCtx } = createMockContext(`${COOKIE_NAME}=${sessionCookieToken}`);
    const authenticatedUser = await sdk.authenticateRequest(trpcCtx.req);
    expect(authenticatedUser).toBeDefined();
    expect(authenticatedUser.email).toBe(testEmail);

    trpcCtx.user = authenticatedUser;
    const caller = appRouter.createCaller(trpcCtx);
    const me = await caller.auth.me();
    expect(me).toBeDefined();
    expect(me?.email).toBe(testEmail);
    expect(me?.name).toBe(testName);
  });

  it("6. Accès aux données protégées (account.dashboard)", async (ctx) => {
    if (!isDbAvailable) {
      ctx.skip();
      return;
    }
    const { ctx: trpcCtx } = createMockContext(`${COOKIE_NAME}=${sessionCookieToken}`);
    trpcCtx.user = await sdk.authenticateRequest(trpcCtx.req);
    const caller = appRouter.createCaller(trpcCtx);

    const dashboard = await caller.account.dashboard();
    expect(dashboard).toBeDefined();
    expect(dashboard.stats).toBeDefined();
    expect(Array.isArray(dashboard.orders)).toBe(true);
    expect(Array.isArray(dashboard.favorites)).toBe(true);
    expect(Array.isArray(dashboard.addresses)).toBe(true);
  });

  it("7. Déconnexion (auth.logout) clears cookie", async (ctx) => {
    if (!isDbAvailable) {
      ctx.skip();
      return;
    }
    const { ctx: trpcCtx, clearedCookies } = createMockContext(`${COOKIE_NAME}=${sessionCookieToken}`);
    trpcCtx.user = await sdk.authenticateRequest(trpcCtx.req);
    const caller = appRouter.createCaller(trpcCtx);

    const logoutResult = await caller.auth.logout();
    expect(logoutResult.success).toBe(true);
    expect(clearedCookies.some((c) => c.name === COOKIE_NAME)).toBe(true);
  });

  it("8. Mot de passe oublié & réinitialisation (auth.forgotPassword / resetPassword)", async (ctx) => {
    if (!isDbAvailable) {
      ctx.skip();
      return;
    }
    const { ctx: trpcCtx } = createMockContext();
    const caller = appRouter.createCaller(trpcCtx);

    // Demande de reset
    const forgotResult = await caller.auth.forgotPassword({ email: testEmail });
    expect(forgotResult.sent).toBe(true);

    // Récupérer le token généré
    const db = await getDb();
    const userRow = (await db!.select().from(users).where(eq(users.email, testEmail)))[0];
    expect(userRow).toBeDefined();

    // Effectuer la réinitialisation
    const newPassword = "NouveauSecretPass2026!";
    // Simuler le reset
    const { storePasswordResetToken } = await import("./db");
    const token = storePasswordResetToken(userRow.id);

    const resetResult = await caller.auth.resetPassword({
      token,
      newPassword,
    });
    expect(resetResult.success).toBe(true);

    // Reconnexion avec le nouveau mot de passe
    const loginNew = await caller.auth.login({
      email: testEmail,
      password: newPassword,
    });
    expect(loginNew.success).toBe(true);
  });

  afterAll(async () => {
    if (!isDbAvailable) return;
    const db = await getDb();
    await db?.delete(users).where(eq(users.email, testEmail));
  });
});
