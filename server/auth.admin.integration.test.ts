import "dotenv/config";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { appRouter } from "./routers";
import { ensureDatabaseConnection } from "./dbConnection";
import { getDb, createOrUpdateAdminUser, adminSuspendUser } from "./db";
import { users } from "../drizzle/schema";
import { inArray } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { getHTTPStatusCodeFromError } from "@trpc/server/http";
import type { TrpcContext } from "./_core/context";
import type { User } from "../drizzle/schema";

function createMockContext(user?: User | null): TrpcContext {
  const cookies: Record<string, string> = {};
  return {
    user: user ?? null,
    req: {
      protocol: "https",
      headers: {},
      cookies,
    } as any,
    res: {
      cookie: (name: string, val: string) => {
        cookies[name] = val;
      },
      clearCookie: (name: string) => {
        delete cookies[name];
      },
    } as any,
  };
}

describe("E2E Auth & Admin Access Control Integration", () => {
  // Comptes dédiés aux tests : ne jamais réutiliser le vrai compte admin,
  // sinon chaque exécution des tests réécrirait son mot de passe.
  const testUserEmail = "test_integration_client@elegancedeco.test";
  const testVendorEmail = "test_integration_vendor@elegancedeco.test";
  const testAdminEmail = "test_integration_admin@elegancedeco.test";
  const testSuspendedEmail = "test_integration_suspended@elegancedeco.test";

  const cleanup = async () => {
    const db = await getDb();
    if (db) await db.delete(users).where(inArray(users.email, [testUserEmail, testAdminEmail, testSuspendedEmail]));
  };

  beforeAll(async () => {
    await ensureDatabaseConnection();
    await cleanup();
  });

  afterAll(cleanup);

  it("1. Création d'un compte client (auth.register)", async () => {
    const ctx = createMockContext();
    const caller = appRouter.createCaller(ctx);

    const res = await caller.auth.register({
      name: "Brahim Client",
      email: testUserEmail,
      password: "TestPassword123!",
      phone: "+216 20 123 456",
    });

    expect(res.success).toBe(true);
    expect(res.user.email).toBe(testUserEmail);
    expect(res.user.role).toBe("user");
  });

  it("2. Connexion client (auth.login)", async () => {
    const ctx = createMockContext();
    const caller = appRouter.createCaller(ctx);

    const res = await caller.auth.login({
      email: testUserEmail,
      password: "TestPassword123!",
    });

    expect(res.success).toBe(true);
    expect(res.user.email).toBe(testUserEmail);
    expect(res.user.role).toBe("user");

    // Tentative avec mauvais mot de passe
    await expect(
      caller.auth.login({
        email: testUserEmail,
        password: "WrongPassword!",
      })
    ).rejects.toThrow("Email ou mot de passe incorrect");
  });

  it("2b. Identifiants refusés : 401 UNAUTHORIZED, même message pour email inconnu et mauvais mot de passe", async () => {
    const caller = appRouter.createCaller(createMockContext());
    const wrongPassword = await caller.auth.login({ email: testUserEmail, password: "WrongPassword!" }).catch((e) => e);
    const unknownEmail = await caller.auth.login({ email: "inconnu_jamais_inscrit@elegancedeco.test", password: "WrongPassword!" }).catch((e) => e);
    for (const error of [wrongPassword, unknownEmail]) {
      expect(error).toBeInstanceOf(TRPCError);
      expect(error.code).toBe("UNAUTHORIZED");
      expect(getHTTPStatusCodeFromError(error)).toBe(401);
      expect(error.message).toBe("Email ou mot de passe incorrect");
    }
    expect(wrongPassword.message).toBe(unknownEmail.message);
  });

  it("2c. Compte suspendu : 403 FORBIDDEN avec le message de suspension, aucune session créée", async () => {
    const register = appRouter.createCaller(createMockContext());
    const created = await register.auth.register({ name: "Compte Suspendu", email: testSuspendedEmail, password: "TestPassword123!" });
    await adminSuspendUser(created.user.id);
    const ctx = createMockContext();
    const cookies: string[] = [];
    ctx.res = { ...ctx.res, cookie: (name: string) => { cookies.push(name); } } as unknown as TrpcContext["res"];
    const error = await appRouter.createCaller(ctx).auth.login({ email: testSuspendedEmail, password: "TestPassword123!" }).catch((e) => e);
    expect(error).toBeInstanceOf(TRPCError);
    expect(error.code).toBe("FORBIDDEN");
    expect(getHTTPStatusCodeFromError(error)).toBe(403);
    expect(error.message).toBe("Ce compte a été suspendu. Contactez l'administration.");
    expect(cookies).toHaveLength(0);
  });

  it("3. Déconnexion (auth.logout)", async () => {
    const ctx = createMockContext();
    const caller = appRouter.createCaller(ctx);

    const res = await caller.auth.logout();
    expect(res.success).toBe(true);
  });

  it("4. Création / accès au compte admin (createOrUpdateAdminUser)", async () => {
    const adminResult = await createOrUpdateAdminUser({
      email: testAdminEmail,
      password: "SuperAdminPassword123!",
      name: "Administrateur Elegance Deco",
    });

    expect(adminResult.user.email).toBe(testAdminEmail);
    expect(adminResult.user.role).toBe("admin");
    expect(adminResult.user.passwordHash).not.toBe("SuperAdminPassword123!");
    expect(adminResult.user.passwordHash?.startsWith("$2")).toBe(true);
  });

  it("5. Connexion admin (auth.login)", async () => {
    const ctx = createMockContext();
    const caller = appRouter.createCaller(ctx);

    const res = await caller.auth.login({
      email: testAdminEmail,
      password: "SuperAdminPassword123!",
    });

    expect(res.success).toBe(true);
    expect(res.user.email).toBe(testAdminEmail);
    expect(res.user.role).toBe("admin");
  });

  it("6. Accès Dashboard Admin avec compte admin", async () => {
    const adminUser = {
      id: 999,
      openId: "test_admin",
      name: "Admin",
      email: testAdminEmail,
      phone: null,
      passwordHash: "hash",
      loginMethod: "email",
      role: "admin" as const,
      suspended: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSignedIn: new Date(),
    };

    const adminCtx = createMockContext(adminUser);
    const adminCaller = appRouter.createCaller(adminCtx);

    const dashboard = await adminCaller.admin.dashboard();
    expect(dashboard).toBeDefined();
    expect(dashboard.stats).toBeDefined();

    const usersList = await adminCaller.admin.listUsers();
    expect(Array.isArray(usersList)).toBe(true);
  });

  it("7. Vérifier qu'un client ne peut pas accéder à l'admin (rejet FORBIDDEN)", async () => {
    const clientUser = {
      id: 998,
      openId: "test_client",
      name: "Client",
      email: testUserEmail,
      phone: null,
      passwordHash: "hash",
      loginMethod: "email",
      role: "user" as const,
      suspended: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSignedIn: new Date(),
    };

    const clientCtx = createMockContext(clientUser);
    const clientCaller = appRouter.createCaller(clientCtx);

    await expect(clientCaller.admin.dashboard()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(clientCaller.admin.listUsers()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("8. Vérifier qu'un vendeur ne peut pas accéder à l'admin (rejet FORBIDDEN)", async () => {
    const vendorUser = {
      id: 997,
      openId: "test_vendor",
      name: "Vendeur",
      email: testVendorEmail,
      phone: null,
      passwordHash: "hash",
      loginMethod: "email",
      role: "vendor" as const,
      suspended: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSignedIn: new Date(),
    };

    const vendorCtx = createMockContext(vendorUser);
    const vendorCaller = appRouter.createCaller(vendorCtx);

    await expect(vendorCaller.admin.dashboard()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(vendorCaller.admin.listUsers()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});
