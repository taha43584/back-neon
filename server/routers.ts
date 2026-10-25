import { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { invokeLLM } from "./_core/llm";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import bcrypt from "bcryptjs";
import { adminProcedure, customerProcedure, protectedProcedure, publicProcedure, router, vendorProcedure } from "./_core/trpc";
import {
  createAddress,
  createOrderWithCommissions,
  createReview,
  createVendorProduct,
  createVendorShop,
  applyForVendorShop,
  updateVendorShop,
  updateVendorProduct,
  toggleVendorProductStatus,
  deleteAddress,
  deleteVendorProduct,
  updateVendorOrderStatus,
  getAdminDashboardData,
  getClientDashboardData,
  getConversationMessages,
  getPublicProductData,
  getPublicShopContact,
  getPublicShopData,
  getPublishedReviews,
  getUserConversations,
  getVendorDashboardData,
  markConversationRead,
  sendConversationMessage,
  startConversation,
  toggleFavorite,
  getFavoriteSlugs,
  toggleFollowShop,
  updateReviewStatus,
  updateShopStatus,
  adminModerateProduct,
  adminUpdateOrderStatus,
  createNativeUser,
  createCustomerUser,
  createVendorUser,
  updateUserProfile,
  findUserByEmail,
  verifyUserPassword,
  storePasswordResetToken,
  consumePasswordResetToken,
  updateUserPassword,
  adminCreateUser,
  adminListUsers,
  adminUpdateUser,
  adminSuspendUser,
  adminUnsuspendUser,
  getCatalogProducts,
  getClientOrderDetail,
  quoteCart,
  BCRYPT_ROUNDS,
  VENDOR_TERMS_VERSION,
} from "./db";
import { selectCatalogCandidates } from "./aiCatalog";
import { sendWelcomeEmail, sendPasswordResetEmail } from "./email";
import { sdk } from "./_core/sdk";
import type { TrpcContext } from "./_core/context";
import type { User } from "../drizzle/schema";
import { customerRegistrationSchema, phoneField, profileUpdateSchema, vendorRegistrationSchema } from "@shared/validation";
import { productInputSchema, SHOP_CATEGORY_NAME_RULE } from "@shared/productValidation";
import {
  adminMergeSiteCategories, adminRenameSiteCategory, adoptShopCategory, createShopCategory, deleteShopCategory,
  listCategoryChoices, listShopCategories, renameShopCategory, reorderShopCategories,
} from "./shopCategories";
import { removeShopImage, updateShopSocialLinks } from "./shopImages";
import { adminListSiteCategories, getCategoryPage, listSiteCategories, setSiteCategoryHidden } from "./siteCategories";
import { normalizeFacebookUrl, normalizeInstagramUrl } from "@shared/shopValidation";
import {
  adminCreateCategory,
  adminListCategories,
  adminModerateCategory,
  deleteProposedCategory,
  deleteVendorMedia,
  deleteVendorProductWithMedia,
  getVendorProduct,
  listPublicCategories,
  listVendorCategories,
  proposeCategory,
  saveVendorProduct,
  setVendorProductStatus,
  updateProposedCategory,
} from "./vendorCatalog";
import {
  adminCategoryList,
  adminClientDetail,
  adminDeleteCategory,
  adminDeleteProduct,
  adminDeleteReview,
  adminListClients,
  adminListOrders,
  adminListProducts,
  adminListReviews,
  adminListVendors,
  adminOrderDetail,
  adminOverview,
  adminProductDetail,
  adminSaveCategory,
  adminSetCategoryActive,
  adminSetProductCategory,
  adminSetProductStatus,
  adminShopOptions,
  adminStats,
  adminVendorDetail,
} from "./adminConsole";
import { getPublicSettings, getSettings, settingsSchema, updateSettings } from "./settings";
import { adminListNeonQuotes, createNeonQuote, getPublicNeonWorkshop, getVendorNeonOffer, listPublicNeonOffers, listVendorNeonQuotes, saveVendorNeonOffer, setVendorNeonQuoteStatus, showNeonBanner } from "./neon";
import { neonOfferSchema } from "@shared/neon";
import { getHomeData } from "./publicCatalog";
import {
  adminListReviewReports, adminResolveReviewReport, adminReviewDetail, adminSetReviewPhotoHidden, listCustomerPhotos, listPublicReviews,
  listReviewableLines, listVendorReviews, productReviewsOverview, replyToReview, reportReview, submitLineReview, toggleHelpful,
} from "./customerReviews";
import { REVIEW_FILTERS, REVIEW_REPLY_MAX, REVIEW_REPORT_MAX, REVIEW_SORTS, reviewSubmissionSchema } from "@shared/reviewRules";

/** Données utilisateur exposées au navigateur (sans hash de mot de passe ni openId). */
export function publicUser(user: User | null | undefined) {
  if (!user) return null;
  return {
    id: user.id,
    name: user.name,
    firstName: user.firstName ?? null,
    lastName: user.lastName ?? null,
    email: user.email,
    phone: user.phone ?? null,
    city: user.city ?? null,
    address: user.address ?? null,
    role: user.role,
    loginMethod: user.loginMethod,
    createdAt: user.createdAt,
  };
}

export const INVALID_CREDENTIALS_MESSAGE = "Email ou mot de passe incorrect";

/**
 * Mesures d'un produit sur mesure (panier, commande). Acceptées telles quelles : c'est la fonction de calcul
 * partagée qui les valide et renvoie un message clair (hors limites, négatives, nulles, non numériques).
 * Aucun montant n'est accepté ici : le prix est toujours recalculé côté serveur.
 */
const customMeasureFields = {
  widthCm: z.union([z.number(), z.string().max(20)]).optional(),
  heightCm: z.union([z.number(), z.string().max(20)]).optional(),
  optionIds: z.array(z.number().int().positive()).max(30).optional(),
  /** Néon personnalisé : choix du client (texte, style, atelier) ; le prix est recalculé depuis l'offre en base */
  neon: z.object({
    shopSlug: z.string().min(1).max(191),
    text: z.string().max(400),
    font: z.string().max(40),
    color: z.string().max(40),
    size: z.string().max(8),
    support: z.string().max(16),
    outdoor: z.boolean(),
  }).optional(),
};

/** Liens sociaux des formulaires de boutique : même normalisation que vendor.shop.updateSocialLinks ("" = supprimé). */
const socialField = (normalize: typeof normalizeFacebookUrl) => z.string().max(400).optional().transform((value, ctx) => {
  if (value === undefined) return undefined;
  const result = normalize(value);
  if (!result.ok) {
    ctx.addIssue({ code: "custom", message: result.error });
    return z.NEVER;
  }
  return result.value;
});
const facebookField = socialField(normalizeFacebookUrl);
const instagramField = socialField(normalizeInstagramUrl);

const shopCategoryName = z.string().trim()
  .min(SHOP_CATEGORY_NAME_RULE.min, `Le nom de la catégorie doit comporter au moins ${SHOP_CATEGORY_NAME_RULE.min} caractères`)
  .max(SHOP_CATEGORY_NAME_RULE.max, `Le nom de la catégorie ne peut pas dépasser ${SHOP_CATEGORY_NAME_RULE.max} caractères`);

/** Hash factice comparé quand l'email est inconnu, pour ne pas révéler l'existence d'un compte par le temps de réponse. */
let dummyPasswordHash: Promise<string> | null = null;
function getDummyPasswordHash() {
  // Même coût que les vrais mots de passe, pour un temps de réponse comparable
  dummyPasswordHash ??= bcrypt.hash("compte-inexistant", BCRYPT_ROUNDS);
  return dummyPasswordHash;
}

async function startSession(ctx: TrpcContext, user: User) {
  const token = await sdk.createSessionToken(user.openId, { name: user.name || user.email || "Utilisateur" });
  ctx.res.cookie(COOKIE_NAME, token, { ...getSessionCookieOptions(ctx.req), maxAge: ONE_YEAR_MS });
}

export const appRouter = router({
    // if you need to use socket.io, read and register route in server/_core/index.ts, all api should start with '/api/' so that the gateway can route correctly
  system: systemRouter,
  auth: router({
    // Ne renvoie jamais le hash du mot de passe ni l'openId au navigateur.
    me: publicProcedure.query(opts => publicUser(opts.ctx.user)),

    registerCustomer: publicProcedure
      .input(customerRegistrationSchema)
      .mutation(async ({ input, ctx }) => {
        const user = await createCustomerUser(input);
        await startSession(ctx, user);
        return { success: true, user: publicUser(user)! };
      }),

    registerVendor: publicProcedure
      .input(vendorRegistrationSchema)
      .mutation(async ({ input, ctx }) => {
        const { user, shop } = await createVendorUser({
          ...input,
          termsAccepted: input.acceptTerms,
          termsVersion: VENDOR_TERMS_VERSION,
        });
        await startSession(ctx, user);
        return {
          success: true,
          user: publicUser(user)!,
          shop: { id: shop.id, name: shop.name, slug: shop.slug, status: shop.status },
        };
      }),

    // Inscription simplifiée historique : crée toujours un compte Client (jamais vendeur ni admin).
    register: publicProcedure
      .input(z.object({
        name: z.string().trim().min(2, "Le nom doit comporter au moins 2 caractères").max(191),
        email: z.string().trim().email("Adresse e-mail invalide").max(320),
        password: z.string().min(8, "Le mot de passe doit comporter au moins 8 caractères").max(128),
        phone: z.string().max(64).optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        const user = await createNativeUser(input);
        if (!user) throw new Error("Erreur lors de la création du compte");
        await startSession(ctx, user);
        return { success: true, user: publicUser(user)! };
      }),

    login: publicProcedure
      .input(z.object({
        email: z.string().trim().email("Adresse e-mail invalide").max(320),
        password: z.string().min(1, "Le mot de passe est requis").max(128),
      }))
      .mutation(async ({ input, ctx }) => {
        // Email inconnu et mauvais mot de passe : même réponse 401, même message, temps comparable
        const user = await findUserByEmail(input.email);
        // Compte inconnu ou sans mot de passe : comparaison factice puis même refus
        if (!user || !user.passwordHash) {
          await bcrypt.compare(input.password, await getDummyPasswordHash());
          throw new TRPCError({ code: "UNAUTHORIZED", message: INVALID_CREDENTIALS_MESSAGE });
        }
        const valid = await verifyUserPassword(user, input.password);
        if (!valid) throw new TRPCError({ code: "UNAUTHORIZED", message: INVALID_CREDENTIALS_MESSAGE });
        if (user.suspended) throw new TRPCError({ code: "FORBIDDEN", message: "Ce compte a été suspendu. Contactez l'administration." });
        await startSession(ctx, user);
        return { success: true, user: publicUser(user)! };
      }),

    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return { success: true } as const;
    }),

    forgotPassword: publicProcedure
      .input(z.object({ email: z.string().email().max(320) }))
      .mutation(async ({ input }) => {
        const user = await findUserByEmail(input.email);
        // Réponse identique qu'il y ait un compte ou non (sécurité)
        if (!user || !user.passwordHash) return { sent: true };
        const token = storePasswordResetToken(user.id);
        await sendPasswordResetEmail(user.email ?? input.email, user.name ?? "", token);
        return { sent: true };
      }),

    resetPassword: publicProcedure
      .input(z.object({
        token: z.string().min(1),
        newPassword: z.string().min(8).max(128),
      }))
      .mutation(async ({ input }) => {
        const userId = consumePasswordResetToken(input.token);
        if (!userId) throw new Error("Token invalide ou expiré");
        await updateUserPassword(userId, input.newPassword);
        return { success: true };
      }),
  }),

  checkout: router({
    // Réservé aux comptes Client. Prix, boutiques et total sont recalculés côté serveur.
    createOrder: customerProcedure.input(z.object({
      totalTnd: z.number().nonnegative().optional(),
      shippingName: z.string().trim().min(2, "Le nom du destinataire est requis").max(191),
      shippingPhone: phoneField(),
      shippingAddress: z.string().trim().min(5, "L'adresse de livraison doit comporter au moins 5 caractères").max(2000),
      shippingCity: z.string().trim().min(2, "La ville est requise").max(128),
      shippingNote: z.string().max(2000).optional(),
      items: z.array(z.object({
        productId: z.number().int().positive().optional(),
        shopId: z.number().int().positive().optional(),
        productSlug: z.string().min(1).max(191),
        productName: z.string().min(1).max(191),
        shopSlug: z.string().min(1).max(191),
        shopName: z.string().min(1).max(191),
        quantity: z.number().int().positive().max(99),
        unitPriceTnd: z.number().nonnegative(),
        selectedColor: z.string().max(64).optional(),
        personalization: z.string().max(2000).optional(),
        ...customMeasureFields,
      })).min(1, "Votre panier est vide").max(100),
    })).mutation(({ ctx, input }) => createOrderWithCommissions(ctx.user.id, input)),
  }),

  neon: router({
    /** « Envoyer mon logo pour un devis » : clients connectés (logo envoyé juste avant via /api/neon/quote-logo). */
    requestQuote: customerProcedure.input(z.object({
      shopSlug: z.string().min(1).max(191),
      mediaId: z.number().int().positive(),
      message: z.string().max(2000).optional(),
      phone: z.string().max(64).optional(),
      sizeCode: z.string().max(8).optional(),
      outdoor: z.boolean().optional(),
    })).mutation(({ ctx, input }) => createNeonQuote(ctx.user.id, input)),
  }),

  account: router({
    dashboard: protectedProcedure.query(({ ctx }) => getClientDashboardData(ctx.user.id)),
    order: protectedProcedure
      .input(z.object({ orderId: z.number().int().positive() }))
      .query(({ ctx, input }) => getClientOrderDetail(ctx.user.id, input.orderId)),
    updateProfile: protectedProcedure
      .input(profileUpdateSchema)
      .mutation(async ({ ctx, input }) => {
        const user = await updateUserProfile(ctx.user.id, input);
        return { success: true, user: publicUser(user) };
      }),
    toggleFavorite: protectedProcedure.input(z.object({ productId: z.number().int().positive().optional(), productSlug: z.string().min(1).max(191), productName: z.string().min(1).max(191), imageUrl: z.string().min(1), priceTnd: z.string().min(1).max(64) })).mutation(({ ctx, input }) => toggleFavorite(ctx.user.id, input)),
    /** Slugs des produits favoris de l'utilisateur connecté (cœurs remplis sur les cartes). */
    favoriteSlugs: protectedProcedure.query(({ ctx }) => getFavoriteSlugs(ctx.user.id)),
    toggleFollowShop: protectedProcedure.input(z.object({ shopId: z.number().int().positive().optional(), shopSlug: z.string().min(1).max(191), shopName: z.string().min(1).max(191) })).mutation(({ ctx, input }) => toggleFollowShop(ctx.user.id, input)),
    addAddress: protectedProcedure.input(z.object({ label: z.string().min(1).max(64), recipientName: z.string().min(2).max(191), phone: z.string().min(6).max(64), addressLine: z.string().min(5).max(2000), city: z.string().min(2).max(128), postalCode: z.string().max(32).optional(), isDefault: z.boolean().optional() })).mutation(({ ctx, input }) => createAddress(ctx.user.id, input)),
    deleteAddress: protectedProcedure.input(z.object({ addressId: z.number().int().positive() })).mutation(({ ctx, input }) => deleteAddress(ctx.user.id, input.addressId)),
  }),

  reviews: router({
    list: publicProcedure.input(z.object({ productSlug: z.string().min(1).max(191) })).query(({ input }) => getPublishedReviews(input.productSlug)),
    submit: protectedProcedure.input(z.object({ productSlug: z.string().min(1).max(191), rating: z.number().int().min(1).max(5), body: z.string().min(10).max(2000) })).mutation(({ ctx, input }) => createReview(ctx.user.id, input)),

    // ----- A-10c : avis complets avec photos (ajouts ; les deux procédures ci-dessus restent pour le site React) -----
    /** Onglets « Ce produit » / « Tout l'atelier » : moyenne, répartition 5→1, 3 critères (avis publiés) */
    overview: publicProcedure.input(z.object({ productSlug: z.string().min(1).max(191) })).query(({ input }) => productReviewsOverview(input.productSlug)),
    page: publicProcedure
      .input(z.object({
        scope: z.enum(["product", "shop"]), slug: z.string().min(1).max(191),
        filter: z.enum(REVIEW_FILTERS).nullable().optional(), sort: z.enum(REVIEW_SORTS).optional(), page: z.number().int().min(1).max(500).optional(),
      }))
      .query(({ ctx, input }) => listPublicReviews(input, ctx.user?.id ?? null)),
    photos: publicProcedure.input(z.object({ scope: z.enum(["product", "shop"]), slug: z.string().min(1).max(191) })).query(({ input }) => listCustomerPhotos(input)),
    /** Lignes livrées à évaluer, avec l'aperçu du nom public */
    reviewableLines: protectedProcedure.query(({ ctx }) => listReviewableLines(ctx.user.id)),
    submitForLine: protectedProcedure.input(reviewSubmissionSchema).mutation(({ ctx, input }) => submitLineReview(ctx.user.id, input)),
    toggleHelpful: protectedProcedure.input(z.object({ reviewId: z.number().int().positive() })).mutation(({ ctx, input }) => toggleHelpful(ctx.user.id, input.reviewId)),
    report: protectedProcedure
      .input(z.object({ reviewId: z.number().int().positive(), reason: z.string().trim().min(5, "Précisez le motif (5 caractères au moins)").max(REVIEW_REPORT_MAX) }))
      .mutation(({ ctx, input }) => reportReview(ctx.user.id, input.reviewId, input.reason)),
  }),

  messages: router({
    list: protectedProcedure.query(({ ctx }) => getUserConversations(ctx.user.id)),
    get: protectedProcedure.input(z.object({ conversationId: z.number().int().positive() })).query(({ ctx, input }) => getConversationMessages(ctx.user.id, input.conversationId)),
    start: protectedProcedure.input(z.object({ shopSlug: z.string().min(1).max(191), body: z.string().min(1).max(4000), subject: z.string().max(191).optional() })).mutation(({ ctx, input }) => startConversation(ctx.user.id, input)),
    send: protectedProcedure.input(z.object({ conversationId: z.number().int().positive(), body: z.string().min(1).max(4000) })).mutation(({ ctx, input }) => sendConversationMessage(ctx.user.id, input.conversationId, input.body)),
    markRead: protectedProcedure.input(z.object({ conversationId: z.number().int().positive() })).mutation(({ ctx, input }) => markConversationRead(ctx.user.id, input.conversationId)),
  }),

  vendor: router({
    contactTarget: publicProcedure.input(z.object({ shopSlug: z.string().min(1).max(191) })).query(({ input }) => getPublicShopContact(input.shopSlug)),
    publicShop: publicProcedure.input(z.object({ shopSlug: z.string().min(1).max(191) })).query(({ input }) => getPublicShopData(input.shopSlug)),
    publicProduct: publicProcedure.input(z.object({ productSlug: z.string().min(1).max(191) })).query(({ input }) => getPublicProductData(input.productSlug)),
    dashboard: vendorProcedure.query(({ ctx }) => getVendorDashboardData(ctx.user.id)),
    /** A-10c : avis de la boutique (photos, critères) et réponse publique unique */
    customerReviews: vendorProcedure.query(({ ctx }) => listVendorReviews(ctx.user.id)),
    replyToReview: vendorProcedure
      .input(z.object({ reviewId: z.number().int().positive(), body: z.string().trim().min(2, "Votre réponse est vide").max(REVIEW_REPLY_MAX) }))
      .mutation(({ ctx, input }) => replyToReview(ctx.user.id, input.reviewId, input.body)),
    
    // Demande pour devenir vendeur
    applyShop: vendorProcedure
      .input(z.object({
        name: z.string().min(2).max(191),
        tagline: z.string().max(500).optional(),
        about: z.string().max(2000).optional(),
        phone: z.string().max(64).optional(),
        address: z.string().max(500).optional(),
        city: z.string().max(128).optional(),
        socialInstagram: instagramField,
        socialFacebook: facebookField,
        socialWebsite: z.string().max(191).optional(),
        openingHours: z.string().max(191).optional(),
      }))
      .mutation(({ ctx, input }) => applyForVendorShop(ctx.user.id, input)),

    createShop: vendorProcedure.input(z.object({
      name: z.string().min(2).max(191),
      tagline: z.string().max(500).optional(),
      about: z.string().max(2000).optional(),
      phone: z.string().max(64).optional(),
      address: z.string().max(500).optional(),
      city: z.string().max(128).optional(),
      socialInstagram: instagramField,
      socialFacebook: facebookField,
      socialWebsite: z.string().max(191).optional(),
      openingHours: z.string().max(191).optional(),
    })).mutation(({ ctx, input }) => applyForVendorShop(ctx.user.id, input)),

    updateShop: vendorProcedure.input(z.object({
      name: z.string().min(2).max(191).optional(),
      tagline: z.string().max(500).optional(),
      about: z.string().max(2000).optional(),
      phone: z.string().max(64).optional(),
      address: z.string().max(500).optional(),
      city: z.string().max(128).optional(),
      socialInstagram: instagramField,
      socialFacebook: facebookField,
      socialWebsite: z.string().max(191).optional(),
      openingHours: z.string().max(191).optional(),
      whatsapp: z.string().max(64).optional(),
      deliveryInfo: z.string().max(2000).optional(),
      showWhatsapp: z.boolean().optional(),
      showPhone: z.boolean().optional(),
      // Le statut de la boutique et le rôle ne font volontairement pas partie de ce schéma
    })).mutation(({ ctx, input }) => updateVendorShop(ctx.user.id, input)),

    createProduct: vendorProcedure.input(z.object({
      name: z.string().min(2).max(191),
      category: z.string().min(2).max(128),
      priceTnd: z.string().regex(/^\d+(?:[.,]\d{1,2})?$/),
      imageUrl: z.string().min(1),
      description: z.string().max(2000).optional(),
      material: z.string().max(500).optional(),
      dimensions: z.string().max(500).optional(),
      delivery: z.string().max(500).optional(),
      badge: z.string().max(64).optional(),
      stock: z.number().int().min(0).optional(),
      customization: z.string().max(500).optional(),
      status: z.enum(["draft", "pending", "published"]).optional(),
    })).mutation(({ ctx, input }) => createVendorProduct(ctx.user.id, input)),

    updateProduct: vendorProcedure.input(z.object({
      productId: z.number().int().positive(),
      name: z.string().min(2).max(191).optional(),
      category: z.string().min(2).max(128).optional(),
      priceTnd: z.string().regex(/^\d+(?:[.,]\d{1,2})?$/).optional(),
      imageUrl: z.string().min(1).optional(),
      description: z.string().max(2000).optional(),
      material: z.string().max(500).optional(),
      dimensions: z.string().max(500).optional(),
      delivery: z.string().max(500).optional(),
      badge: z.string().max(64).optional(),
      stock: z.number().int().min(0).optional(),
      customization: z.string().max(500).optional(),
      status: z.enum(["draft", "pending", "published"]).optional(),
    })).mutation(({ ctx, input }) => {
      const { productId, ...data } = input;
      return updateVendorProduct(ctx.user.id, productId, data);
    }),

    toggleProductStatus: vendorProcedure.input(z.object({
      productId: z.number().int().positive(),
    })).mutation(({ ctx, input }) => toggleVendorProductStatus(ctx.user.id, input.productId)),

    deleteProduct: vendorProcedure.input(z.object({
      productId: z.number().int().positive(),
    })).mutation(({ ctx, input }) => deleteVendorProduct(ctx.user.id, input.productId)),

    // --- Catalogue professionnel du vendeur ---
    product: vendorProcedure
      .input(z.object({ productId: z.number().int().positive() }))
      .query(({ ctx, input }) => getVendorProduct(ctx.user.id, input.productId)),

    saveProduct: vendorProcedure
      .input(productInputSchema)
      .mutation(({ ctx, input }) => saveVendorProduct(ctx.user.id, input)),

    setProductStatus: vendorProcedure
      .input(z.object({ productId: z.number().int().positive(), status: z.enum(["draft", "published"]) }))
      .mutation(({ ctx, input }) => setVendorProductStatus(ctx.user.id, input.productId, input.status)),

    removeProduct: vendorProcedure
      .input(z.object({ productId: z.number().int().positive() }))
      .mutation(({ ctx, input }) => deleteVendorProductWithMedia(ctx.user.id, input.productId)),

    deleteMedia: vendorProcedure
      .input(z.object({ mediaId: z.number().int().positive() }))
      .mutation(({ ctx, input }) => deleteVendorMedia(ctx.user.id, input.mediaId)),

    // Identité visuelle et réseaux de la boutique du vendeur connecté (l'envoi d'image passe par POST /api/vendor/shop/:slot)
    shop: router({
      removeLogo: vendorProcedure.mutation(({ ctx }) => removeShopImage(ctx.user.id, "logo")),
      removeCover: vendorProcedure.mutation(({ ctx }) => removeShopImage(ctx.user.id, "cover")),
      updateSocialLinks: vendorProcedure
        .input(z.object({ facebook: z.string().max(400).nullable().optional(), instagram: z.string().max(400).nullable().optional() }))
        .mutation(({ ctx, input }) => updateShopSocialLinks(ctx.user.id, input)),
    }),

    // Catégories propres à la boutique : la boutique vient toujours de la session, jamais de l'input
    neon: router({
      offer: vendorProcedure.query(({ ctx }) => getVendorNeonOffer(ctx.user.id)),
      saveOffer: vendorProcedure.input(neonOfferSchema).mutation(({ ctx, input }) => saveVendorNeonOffer(ctx.user.id, input)),
      quotes: vendorProcedure.query(({ ctx }) => listVendorNeonQuotes(ctx.user.id)),
      setQuoteStatus: vendorProcedure
        .input(z.object({ id: z.number().int().positive(), status: z.enum(["new", "seen", "answered", "closed"]) }))
        .mutation(({ ctx, input }) => setVendorNeonQuoteStatus(ctx.user.id, input.id, input.status)),
    }),
    shopCategories: router({
      list: vendorProcedure.query(({ ctx }) => listShopCategories(ctx.user.id)),
      // Sélecteur : catégories de SA boutique + NOMS des catégories des autres boutiques (non masquées)
      choices: vendorProcedure.query(({ ctx }) => listCategoryChoices(ctx.user.id)),
      adopt: vendorProcedure
        .input(z.object({ slug: z.string().min(1).max(120) }))
        .mutation(({ ctx, input }) => adoptShopCategory(ctx.user.id, input)),
      create: vendorProcedure.input(z.object({ name: shopCategoryName })).mutation(({ ctx, input }) => createShopCategory(ctx.user.id, input)),
      rename: vendorProcedure
        .input(z.object({ categoryId: z.number().int().positive(), name: shopCategoryName }))
        .mutation(({ ctx, input }) => renameShopCategory(ctx.user.id, input)),
      delete: vendorProcedure
        .input(z.object({ categoryId: z.number().int().positive() }))
        .mutation(({ ctx, input }) => deleteShopCategory(ctx.user.id, input)),
      reorder: vendorProcedure
        .input(z.object({ orderedIds: z.array(z.number().int().positive()).max(500) }))
        .mutation(({ ctx, input }) => reorderShopCategories(ctx.user.id, input)),
    }),

    categories: vendorProcedure.query(({ ctx }) => listVendorCategories(ctx.user.id)),

    proposeCategory: vendorProcedure
      .input(z.object({ name: z.string().trim().min(2, "Le nom doit comporter au moins 2 caractères").max(128), parentId: z.number().int().positive().nullable().optional() }))
      .mutation(({ ctx, input }) => proposeCategory(ctx.user.id, input)),

    updateCategory: vendorProcedure
      .input(z.object({ categoryId: z.number().int().positive(), name: z.string().trim().min(2, "Le nom doit comporter au moins 2 caractères").max(128), parentId: z.number().int().positive().nullable().optional() }))
      .mutation(({ ctx, input }) => updateProposedCategory(ctx.user.id, input)),

    deleteCategory: vendorProcedure
      .input(z.object({ categoryId: z.number().int().positive(), reassignToCategoryId: z.number().int().positive().optional() }))
      .mutation(({ ctx, input }) => deleteProposedCategory(ctx.user.id, input)),

    updateOrderStatus: vendorProcedure.input(z.object({
      orderId: z.number().int().positive(),
      status: z.enum(["pending", "processing", "shipped", "delivered", "cancelled"]),
    })).mutation(({ ctx, input }) => updateVendorOrderStatus(ctx.user.id, input.orderId, input.status)),
  }),

  admin: router({
    dashboard: adminProcedure.query(() => getAdminDashboardData()),
    categories: adminProcedure.query(() => adminListCategories()),
    moderateCategory: adminProcedure
      .input(z.object({ categoryId: z.number().int().positive(), status: z.enum(["approved", "rejected"]) }))
      .mutation(({ input }) => adminModerateCategory(input.categoryId, input.status)),
    createCategory: adminProcedure
      .input(z.object({ name: z.string().trim().min(2, "Le nom doit comporter au moins 2 caractères").max(128), parentId: z.number().int().positive().nullable().optional() }))
      .mutation(({ input }) => adminCreateCategory(input)),
    updateShopStatus: adminProcedure.input(z.object({
      shopId: z.number().int().positive(),
      status: z.enum(["pending", "active", "suspended", "rejected"]),
      rejectionReason: z.string().max(1000).optional(),
    }).refine((d) => d.status !== "rejected" || (d.rejectionReason?.trim().length ?? 0) >= 3, {
      message: "Indiquez le motif du refus (au moins 3 caractères)",
      path: ["rejectionReason"],
    })).mutation(({ input }) => updateShopStatus(input.shopId, input.status, input.rejectionReason)),

    updateReviewStatus: adminProcedure.input(z.object({
      reviewId: z.number().int().positive(),
      status: z.enum(["pending", "published", "rejected"]),
    })).mutation(({ input }) => updateReviewStatus(input.reviewId, input.status)),

    moderateProduct: adminProcedure.input(z.object({
      productId: z.number().int().positive(),
      status: z.enum(["draft", "pending", "published"]).optional(),
      delete: z.boolean().optional(),
    })).mutation(({ input }) => adminModerateProduct(input.productId, input)),

    updateOrderStatus: adminProcedure.input(z.object({
      orderId: z.number().int().positive(),
      status: z.enum(["pending", "processing", "shipped", "delivered", "cancelled"]),
      note: z.string().max(1000).optional(),
    })).mutation(({ ctx, input }) => adminUpdateOrderStatus(input.orderId, input.status, ctx.user.id, input.note)),

    // --- Console d'administration (listes paginées, détails, modération) ---
    overview: adminProcedure.query(() => adminOverview()),
    clients: adminProcedure
      .input(z.object({ search: z.string().max(191).optional(), status: z.enum(["all", "active", "suspended"]).optional(), page: z.number().int().positive().optional() }))
      .query(({ input }) => adminListClients(input)),
    client: adminProcedure.input(z.object({ userId: z.number().int().positive() })).query(({ input }) => adminClientDetail(input.userId)),
    vendors: adminProcedure
      .input(z.object({ search: z.string().max(191).optional(), status: z.enum(["all", "pending", "active", "suspended", "rejected"]).optional(), page: z.number().int().positive().optional() }))
      .query(({ input }) => adminListVendors(input)),
    vendor: adminProcedure.input(z.object({ shopId: z.number().int().positive() })).query(({ input }) => adminVendorDetail(input.shopId)),
    shopOptions: adminProcedure.query(() => adminShopOptions()),
    products: adminProcedure
      .input(z.object({
        search: z.string().max(191).optional(),
        shopId: z.number().int().positive().optional(),
        categoryId: z.number().int().positive().optional(),
        status: z.enum(["all", "draft", "pending", "published", "rejected"]).optional(),
        minPrice: z.number().min(0).optional(),
        maxPrice: z.number().min(0).optional(),
        page: z.number().int().positive().optional(),
      }))
      .query(({ input }) => adminListProducts(input)),
    product: adminProcedure.input(z.object({ productId: z.number().int().positive() })).query(({ input }) => adminProductDetail(input.productId)),
    setProductStatus: adminProcedure
      .input(z.object({ productId: z.number().int().positive(), action: z.enum(["publish", "unpublish", "reject"]), reason: z.string().max(1000).optional() })
        .refine((d) => d.action !== "reject" || (d.reason?.trim().length ?? 0) >= 3, { message: "Indiquez le motif du refus (au moins 3 caractères)", path: ["reason"] }))
      .mutation(({ input }) => adminSetProductStatus(input)),
    deleteProduct: adminProcedure.input(z.object({ productId: z.number().int().positive() })).mutation(({ input }) => adminDeleteProduct(input.productId)),
    // Catégories du site (regroupées) : masquer / réafficher un nom inapproprié, sans rien supprimer
    siteCategories: adminProcedure.query(() => adminListSiteCategories()),
    neonQuotes: adminProcedure.query(() => adminListNeonQuotes()),
    setSiteCategoryHidden: adminProcedure
      .input(z.object({ slug: z.string().min(1).max(120), hidden: z.boolean(), reason: z.string().max(255).nullable().optional() }))
      .mutation(({ ctx, input }) => setSiteCategoryHidden(input, ctx.user.id)),
    renameSiteCategory: adminProcedure
      .input(z.object({ slug: z.string().min(1).max(120), name: shopCategoryName }))
      .mutation(({ input }) => adminRenameSiteCategory(input)),
    mergeSiteCategories: adminProcedure
      .input(z.object({ sourceSlug: z.string().min(1).max(120), targetSlug: z.string().min(1).max(120) }))
      .mutation(({ input }) => adminMergeSiteCategories(input)),
    // Catégorie globale du site (navigation), facultative : null la retire
    setProductCategory: adminProcedure
      .input(z.object({ productId: z.number().int().positive(), categoryId: z.number().int().positive().nullable() }))
      .mutation(({ input }) => adminSetProductCategory(input)),
    categoryList: adminProcedure.query(() => adminCategoryList()),
    saveCategory: adminProcedure
      .input(z.object({
        id: z.number().int().positive().optional(),
        name: z.string().trim().min(2, "Le nom doit comporter au moins 2 caractères").max(128),
        description: z.string().max(2000).nullable().optional(),
        parentId: z.number().int().positive().nullable().optional(),
        active: z.boolean().optional(),
      }))
      .mutation(({ input }) => adminSaveCategory(input)),
    setCategoryActive: adminProcedure.input(z.object({ categoryId: z.number().int().positive(), active: z.boolean() })).mutation(({ input }) => adminSetCategoryActive(input.categoryId, input.active)),
    deleteCategory: adminProcedure
      .input(z.object({ categoryId: z.number().int().positive(), reassignToCategoryId: z.number().int().positive().optional() }))
      .mutation(({ input }) => adminDeleteCategory(input)),
    orders: adminProcedure
      .input(z.object({
        search: z.string().max(191).optional(),
        status: z.enum(["all", "pending", "processing", "shipped", "delivered", "cancelled"]).optional(),
        shopId: z.number().int().positive().optional(),
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        page: z.number().int().positive().optional(),
      }))
      .query(({ input }) => adminListOrders(input)),
    order: adminProcedure.input(z.object({ orderId: z.number().int().positive() })).query(({ input }) => adminOrderDetail(input.orderId)),
    reviews: adminProcedure
      .input(z.object({ status: z.enum(["all", "pending", "published", "rejected"]).optional(), search: z.string().max(191).optional(), page: z.number().int().positive().optional() }))
      .query(({ input }) => adminListReviews(input)),
    deleteReview: adminProcedure.input(z.object({ reviewId: z.number().int().positive() })).mutation(({ input }) => adminDeleteReview(input.reviewId)),
    // A-10c : détail d'un avis (photos, signalements), photo masquée / réaffichée, signalements
    reviewDetail: adminProcedure.input(z.object({ reviewId: z.number().int().positive() })).query(({ input }) => adminReviewDetail(input.reviewId)),
    setReviewPhotoHidden: adminProcedure
      .input(z.object({ photoId: z.number().int().positive(), hidden: z.boolean() }))
      .mutation(({ ctx, input }) => adminSetReviewPhotoHidden(ctx.user.id, input.photoId, input.hidden)),
    reviewReports: adminProcedure.input(z.object({ status: z.enum(["open", "resolved", "all"]).optional() })).query(({ input }) => adminListReviewReports(input.status ?? "open")),
    resolveReviewReport: adminProcedure.input(z.object({ reportId: z.number().int().positive() })).mutation(({ ctx, input }) => adminResolveReviewReport(ctx.user.id, input.reportId)),
    stats: adminProcedure.input(z.object({ period: z.enum(["7d", "30d", "90d", "12m"]) })).query(({ input }) => adminStats(input.period)),
    settings: adminProcedure.query(() => getSettings()),
    updateSettings: adminProcedure
      .input(settingsSchema.partial())
      .mutation(async ({ ctx, input }) => {
        // La catégorie du configurateur néon doit être une catégorie existante du site
        if (input.neonCategorySlug && !(await adminListSiteCategories()).some((c) => c.slug === input.neonCategorySlug)) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Cette catégorie n'existe pas sur le site" });
        }
        return updateSettings(input, ctx.user.id);
      }),

    createUser: adminProcedure
      .input(z.object({
        name: z.string().min(2).max(191),
        email: z.string().email().max(320),
        phone: z.string().max(64).optional(),
        password: z.string().min(8).max(128).optional(),
        role: z.enum(["customer", "seller"]),
        shopName: z.string().min(2).max(191).optional(),
        shopDescription: z.string().max(2000).optional(),
      }).refine(d => d.role !== "seller" || !!d.shopName, {
        message: "Le nom de la boutique est requis pour un vendeur",
        path: ["shopName"],
      }))
      .mutation(async ({ input }) => {
        const result = await adminCreateUser({
          name: input.name,
          email: input.email,
          phone: input.phone,
          password: input.password,
          role: input.role,
          shopName: input.shopName,
          shopDescription: input.shopDescription,
        });
        // Envoi de l'email de bienvenue (non-bloquant)
        await sendWelcomeEmail(input.email, input.name, result.plainPassword);
        return {
          success: true,
          userId: result.user.id,
          shopId: result.shop?.id ?? null,
          plainPassword: result.plainPassword,
        };
      }),

    listUsers: adminProcedure
      .input(z.object({
        role: z.enum(["user", "vendor", "admin"]).optional(),
      }).optional())
      .query(({ input }) => adminListUsers(input?.role)),

    updateUser: adminProcedure
      .input(z.object({
        id: z.number().int().positive(),
        name: z.string().min(2).max(191).optional(),
        email: z.string().email().max(320).optional(),
        phone: z.string().max(64).optional(),
        role: z.enum(["user", "vendor", "admin"]).optional(),
      }))
      .mutation(({ input }) => {
        const { id, ...data } = input;
        return adminUpdateUser(id, data);
      }),

    suspendUser: adminProcedure
      .input(z.object({ id: z.number().int().positive() }))
      .mutation(({ input }) => adminSuspendUser(input.id)),

    unsuspendUser: adminProcedure
      .input(z.object({ id: z.number().int().positive() }))
      .mutation(({ input }) => adminUnsuspendUser(input.id)),
  }),

  catalog: router({
    categories: publicProcedure.query(() => listPublicCategories()),
    // Catégories du site : vendeurs + globales regroupées (accueil, menu « Toutes les catégories »)
    siteCategories: publicProcedure.query(() => listSiteCategories()),
    categoryPage: publicProcedure
      .input(z.object({
        slug: z.string().min(1).max(120),
        custom: z.boolean().optional(),
        promo: z.boolean().optional(),
        minPrice: z.number().min(0).max(1_000_000).optional(),
        maxPrice: z.number().min(0).max(1_000_000).optional(),
        shops: z.array(z.string().min(1).max(191)).max(50).optional(),
        sort: z.enum(["recent", "price_asc", "price_desc"]).optional(),
      }))
      .query(async ({ input }) => {
        const { slug, ...filters } = input;
        const [page, neonBanner] = await Promise.all([getCategoryPage(slug, filters), showNeonBanner(slug)]);
        return { ...page, neonBanner };
      }),

    list: publicProcedure
      .input(z.object({
        search: z.string().max(191).optional(),
        category: z.string().max(128).optional(),
        minPrice: z.number().min(0).optional(),
        maxPrice: z.number().min(0).optional(),
        sort: z.enum(["pertinence", "prix_asc", "prix_desc", "note_desc", "recent"]).optional(),
        discount: z.boolean().optional(),
        /** Sur mesure : prix au m² ou au mètre linéaire */
        custom: z.boolean().optional(),
      }).optional())
      .query(async ({ input }) => {
        // Fetch vendor products from DB
        const dbProducts = await getCatalogProducts({
          search: input?.search,
          category: input?.category,
          minPrice: input?.minPrice,
          maxPrice: input?.maxPrice,
          sort: input?.sort,
        });

        // Map DB products to unified catalog shape
        const dbMapped = dbProducts.map((p) => ({
          id: p.id,
          slug: p.slug,
          name: p.name,
          shopSlug: p.shopSlug,
          shopName: p.shopName,
          shopLogoUrl: p.shopLogoUrl ?? null,
          price: `${p.priceTnd.toFixed(2).replace('.', ',')} TND`,
          priceTnd: p.priceTnd,
          regularPriceTnd: p.regularPriceTnd,
          promoPriceTnd: p.promoPriceTnd,
          oldPrice: p.promoPriceTnd != null ? `${p.regularPriceTnd.toFixed(2).replace('.', ',')} TND` : null,
          availability: p.availability as "in_stock" | "made_to_order" | "out_of_stock",
          pricingMode: p.pricingMode,
          image: p.imageUrl,
          badge: p.badge ?? "Nouveau",
          tint: p.tint ?? "bg-[#f5ede7]",
          category: p.category,
          description: p.description ?? "",
          material: p.material ?? "",
          dimensions: p.dimensions ?? "",
          delivery: p.delivery ?? "",
          rating: p.rating,
          reviewCount: p.reviewCount,
          source: "db" as const,
        }));

        // Uniquement les produits réels : publiés par une boutique validée (aucun produit de démonstration)
        let result = dbMapped;
        if (input?.discount) result = result.filter((p) => p.oldPrice !== null);
        if (input?.custom) result = result.filter((p) => p.pricingMode !== "fixed");
        return result;
      }),

    /** Données réelles de la page d'accueil (catégories, nouveautés, populaires, boutiques). */
    home: publicProcedure.query(() => getHomeData()),

    /** Boutiques validées (page « Boutiques »). */
    shops: publicProcedure.query(async () => (await getHomeData()).allShops),

    /** Paramètres publics du marketplace (nom, coordonnées, livraison, conditions). */
    settings: publicProcedure.query(() => getPublicSettings()),

    /** Ateliers qui proposent le néon personnalisé (boutique active, offre activée et complète). */
    neonOffers: publicProcedure.query(() => listPublicNeonOffers()),
    /** Configurateur d'UN atelier (/neon/<slug>) : null si l'atelier n'est pas (ou plus) visible. */
    neonWorkshop: publicProcedure.input(z.object({ shopSlug: z.string().min(1).max(191) })).query(({ input }) => getPublicNeonWorkshop(input.shopSlug)),

    /** Prix, promotions et stock recalculés par le serveur pour le panier. */
    quoteCart: publicProcedure
      .input(z.object({ lines: z.array(z.object({ productSlug: z.string().min(1).max(191), quantity: z.number().int().positive().max(99), ...customMeasureFields })).max(100) }))
      .query(({ input }) => quoteCart(input.lines)),
  }),

  ai: router({
    chat: publicProcedure
      .input(z.object({
        messages: z.array(z.object({
          role: z.enum(["user", "assistant", "system"]),
          content: z.string().min(1).max(4000),
        })).min(1).max(12),
        style: z.string().min(2).max(64).optional(),
        budget: z.string().min(2).max(64).optional(),
      }))
      .mutation(async ({ input }) => {
        // L'assistant ne connaît que les produits réellement en vente
        const liveProducts = (await getCatalogProducts()).map((p) => ({
          name: p.name,
          price: `${p.priceTnd.toFixed(2)} DT`,
          category: p.category,
          shopName: p.shopName,
          description: p.description ?? "",
          material: p.material ?? "",
          dimensions: p.dimensions ?? "",
        }));
        const candidates = selectCatalogCandidates(liveProducts, { style: input.style, budget: input.budget }).slice(0, 40);
        const catalogContext = candidates.map((product) => `${product.name} | ${product.price} | catégorie: ${product.category} | boutique: ${product.shopName} | dimensions: ${product.dimensions} | matière: ${product.material}`).join("\\n");
        const response = await invokeLLM({
          messages: [
            {
              role: "system",
              content: `Tu es l'assistant Déco IA d'Elegance Deco, marketplace tunisienne de décoration. Réponds en français, de façon chaleureuse, concrète et concise. Aide à choisir des styles, matières, dimensions, couleurs et produits du catalogue. Tu ne peux citer que les produits présents dans le catalogue ci-dessous; n'invente jamais de produit, disponibilité, note, avis, vente ou caractéristique. Si aucune création ne correspond, dis-le clairement et propose une prochaine étape. Les critères structurés sélectionnés par l'utilisateur sont : style = ${input.style ?? "non précisé"}, budget = ${input.budget ?? "non précisé"}. Ne recommande que des produits dont le prix et les caractéristiques sont compatibles avec ces critères, et indique clairement quand aucun produit ne correspond.\n\nCATALOGUE RÉEL:\n${catalogContext}`,
            },
            ...input.messages.filter((message) => message.role !== "system"),
          ],
        });
        const content = response.choices?.[0]?.message?.content;
        if (typeof content === "string") return content;
        if (Array.isArray(content)) return content.map((part) => typeof part === "string" ? part : "text" in part ? part.text : "").join("");
        return "Je n'ai pas pu générer une réponse pour le moment. Réessayez dans quelques instants.";
      }),
  }),

  // TODO: add feature routers here, e.g.
  // todo: router({
  //   list: protectedProcedure.query(({ ctx }) =>
  //     db.getUserTodos(ctx.user.id)
  //   ),
  // }),
});

export type AppRouter = typeof appRouter;
