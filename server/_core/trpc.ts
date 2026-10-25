import { NOT_ADMIN_ERR_MSG, UNAUTHED_ERR_MSG } from '@shared/const';
import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import { ZodError } from "zod";
import { fieldErrors } from "@shared/validation";
import type { TrpcContext } from "./context";

const DB_UNAVAILABLE_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "PROTOCOL_CONNECTION_LOST", "ER_CON_COUNT_ERROR", "ER_BAD_DB_ERROR", "ER_ACCESS_DENIED_ERROR"]);

/**
 * Drizzle enveloppe toute erreur du driver MySQL dans « Failed query: … » et cache
 * la vraie cause (ex. ECONNREFUSED quand MySQL est arrêté) dans `error.cause`.
 * On journalise la cause côté serveur et on renvoie un message compréhensible,
 * sans exposer la requête SQL ni ses paramètres au navigateur.
 */
export function describeDatabaseError(error: unknown): { message: string; cause: string } | null {
  const err = error as { message?: string; cause?: { code?: string; message?: string } } | undefined;
  if (!err?.message?.startsWith("Failed query")) return null;
  const code = err.cause?.code ?? "";
  const cause = code ? `${code} — ${err.cause?.message ?? ""}` : (err.cause?.message ?? "cause inconnue");
  const message = DB_UNAVAILABLE_CODES.has(code)
    ? "La base de données est momentanément indisponible. Réessayez dans quelques instants."
    : "Une erreur technique est survenue lors de l'accès aux données. Réessayez ou contactez le support.";
  return { message, cause };
}

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
  errorFormatter({ shape, error, path }) {
    if (error.cause instanceof ZodError) {
      const errors = fieldErrors(error.cause);
      return { ...shape, message: Object.values(errors)[0] ?? "Données invalides", data: { ...shape.data, fieldErrors: errors } };
    }
    const dbError = describeDatabaseError(error.cause ?? error);
    if (!dbError) return { ...shape, data: { ...shape.data, fieldErrors: null } };
    console.error(`[Database] Échec sur ${path ?? "?"} : ${dbError.cause}`);
    return { ...shape, message: dbError.message, data: { ...shape.data, fieldErrors: null } };
  },
});

export const router = t.router;
export const publicProcedure = t.procedure;

const requireUser = t.middleware(async opts => {
  const { ctx, next } = opts;

  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
  }

  return next({
    ctx: {
      ...ctx,
      user: ctx.user,
    },
  });
});

export const protectedProcedure = t.procedure.use(requireUser);

/** Réservé aux comptes Client (rôle `user`). */
export const customerProcedure = protectedProcedure.use(
  t.middleware(async ({ ctx, next }) => {
    if (ctx.user?.role !== "user") {
      throw new TRPCError({ code: "FORBIDDEN", message: "Cette action est réservée aux comptes Client." });
    }
    return next();
  }),
);

/** Réservé aux comptes Vendeur (rôle `vendor`). L'activation de la boutique est vérifiée dans chaque action. */
export const vendorProcedure = protectedProcedure.use(
  t.middleware(async ({ ctx, next }) => {
    if (ctx.user?.role !== "vendor") {
      throw new TRPCError({ code: "FORBIDDEN", message: "Cet espace est réservé aux comptes Vendeur." });
    }
    return next();
  }),
);

export const adminProcedure = t.procedure.use(
  t.middleware(async opts => {
    const { ctx, next } = opts;

    if (!ctx.user || ctx.user.role !== 'admin') {
      throw new TRPCError({ code: "FORBIDDEN", message: NOT_ADMIN_ERR_MSG });
    }

    return next({
      ctx: {
        ...ctx,
        user: ctx.user,
      },
    });
  }),
);
