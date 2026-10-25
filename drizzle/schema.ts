import { int, mysqlEnum, mysqlTable, text, timestamp, tinyint, varchar, decimal, unique, index } from "drizzle-orm/mysql-core";

export const users = mysqlTable("users", {
  id: int("id").autoincrement().primaryKey(),
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  firstName: varchar("firstName", { length: 128 }),
  lastName: varchar("lastName", { length: 128 }),
  email: varchar("email", { length: 320 }),
  phone: varchar("phone", { length: 64 }),
  city: varchar("city", { length: 128 }),
  address: text("address"),
  passwordHash: varchar("passwordHash", { length: 255 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin", "vendor"]).default("user").notNull(),
  suspended: int("suspended").notNull().default(0),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

export const shops = mysqlTable("shops", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  name: varchar("name", { length: 191 }).notNull(),
  slug: varchar("slug", { length: 191 }).notNull().unique(),
  tagline: text("tagline"),
  about: text("about"),
  coverUrl: text("coverUrl"),
  logoUrl: text("logoUrl"),
  phone: varchar("phone", { length: 64 }),
  whatsapp: varchar("whatsapp", { length: 64 }),
  // Visibilité publique choisie par le vendeur (masqués par défaut)
  showWhatsapp: int("showWhatsapp").notNull().default(0),
  showPhone: int("showPhone").notNull().default(0),
  address: text("address"),
  city: varchar("city", { length: 128 }),
  socialInstagram: varchar("socialInstagram", { length: 191 }),
  socialFacebook: varchar("socialFacebook", { length: 191 }),
  socialWebsite: varchar("socialWebsite", { length: 191 }),
  openingHours: varchar("openingHours", { length: 191 }),
  deliveryInfo: text("deliveryInfo"),
  status: mysqlEnum("status", ["pending", "active", "suspended", "rejected"]).default("pending").notNull(),
  rejectionReason: text("rejectionReason"),
  termsAccepted: int("termsAccepted").notNull().default(0),
  termsVersion: varchar("termsVersion", { length: 32 }),
  termsAcceptedAt: timestamp("termsAcceptedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export const categories = mysqlTable("categories", {
  id: int("id").autoincrement().primaryKey(),
  name: varchar("name", { length: 128 }).notNull(),
  slug: varchar("slug", { length: 128 }).notNull().unique(),
  description: text("description"),
  // Hiérarchie à deux niveaux : catégorie principale (parentId null) > sous-catégorie
  parentId: int("parentId"),
  // Les catégories globales sont `approved` ; celles proposées par un vendeur restent `pending` jusqu'à validation admin
  status: mysqlEnum("status", ["approved", "pending", "rejected"]).default("approved").notNull(),
  // Une catégorie désactivée disparaît du site public sans être supprimée
  active: int("active").notNull().default(1),
  proposedByShopId: int("proposedByShopId"),
  sortOrder: int("sortOrder").notNull().default(0),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

/** Catégories créées librement par chaque vendeur pour classer SES produits (nom unique par boutique, casse et accents ignorés). */
export const shopCategories = mysqlTable("shop_categories", {
  id: int("id").autoincrement().primaryKey(),
  shopId: int("shopId").notNull().references(() => shops.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 50 }).notNull(),
  slug: varchar("slug", { length: 64 }).notNull(),
  position: int("position").notNull().default(0),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => ({
  shopNameUnique: unique("shop_categories_shop_name_unique").on(table.shopId, table.name),
  shopSlugUnique: unique("shop_categories_shop_slug_unique").on(table.shopId, table.slug),
  shopPositionIdx: index("shop_categories_shop_position_idx").on(table.shopId, table.position),
}));

export type ShopCategory = typeof shopCategories.$inferSelect;

export const products = mysqlTable("products", {
  id: int("id").autoincrement().primaryKey(),
  shopId: int("shopId").notNull(),
  name: varchar("name", { length: 191 }).notNull(),
  slug: varchar("slug", { length: 191 }).notNull().unique(),
  category: varchar("category", { length: 128 }).notNull(),
  categoryId: int("categoryId"),
  // Catégorie propre à la boutique (choisie par le vendeur) ; NULL = « Sans catégorie »
  shopCategoryId: int("shopCategoryId").references(() => shopCategories.id, { onDelete: "set null" }),
  priceTnd: decimal("priceTnd", { precision: 10, scale: 2 }).notNull(),
  description: text("description"),
  material: text("material"),
  dimensions: text("dimensions"),
  delivery: text("delivery"),
  imageUrl: text("imageUrl").notNull(),
  badge: varchar("badge", { length: 64 }),
  tint: varchar("tint", { length: 64 }),
  // pending : en attente de validation admin ; rejected : refusé par l'admin (motif dans moderationNote)
  status: mysqlEnum("status", ["draft", "pending", "published", "rejected"]).default("published").notNull(),
  stock: int("stock").default(1),
  customization: text("customization"),
  promoPriceTnd: decimal("promoPriceTnd", { precision: 10, scale: 2 }),
  // Prix sur mesure : "fixed" = comportement historique (priceTnd) ; sinon prix calculé selon les mesures du client
  pricingMode: mysqlEnum("pricingMode", ["fixed", "per_m2", "per_linear_m"]).default("fixed").notNull(),
  unitPriceTnd: decimal("unitPriceTnd", { precision: 10, scale: 3 }),
  // En mode « mètre linéaire », la longueur utilise minWidthCm / maxWidthCm
  minWidthCm: int("minWidthCm"),
  maxWidthCm: int("maxWidthCm"),
  minHeightCm: int("minHeightCm"),
  maxHeightCm: int("maxHeightCm"),
  // m² (ou mètres en mode linéaire)
  minBillableArea: decimal("minBillableArea", { precision: 8, scale: 3 }),
  minPriceTnd: decimal("minPriceTnd", { precision: 10, scale: 3 }),
  // Remise en % appliquée au prix calculé (produits sur mesure uniquement)
  promoPercent: decimal("promoPercent", { precision: 5, scale: 2 }),
  sku: varchar("sku", { length: 64 }),
  // JSON : { dimensions: string[], colors: string[], materials: string[], models: string[] }
  variants: text("variants"),
  availability: mysqlEnum("availability", ["in_stock", "made_to_order", "out_of_stock"]).default("in_stock").notNull(),
  preparationTime: varchar("preparationTime", { length: 128 }),
  extraInfo: text("extraInfo"),
  // Vidéo externe sécurisée (YouTube / Vimeo, stockée sous forme d'URL d'intégration)
  videoUrl: varchar("videoUrl", { length: 500 }),
  moderationNote: text("moderationNote"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

/**
 * Catégorie du site masquée par l'administration (nom inapproprié). Rien n'est jamais supprimé :
 * masquer / réafficher bascule `hidden`. La clé est categorySlug(nom) (shared/categoryKey.ts) :
 * une catégorie masquée puis recréée par un vendeur avec le même nom reste masquée.
 */
export const hiddenSiteCategories = mysqlTable("hidden_site_categories", {
  slug: varchar("slug", { length: 120 }).primaryKey(),
  label: varchar("label", { length: 120 }).notNull(),
  hidden: int("hidden").notNull().default(1),
  reason: varchar("reason", { length: 255 }),
  hiddenByUserId: int("hiddenByUserId"),
  hiddenAt: timestamp("hiddenAt").defaultNow().notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

/** Options facultatives d'un produit sur mesure (ex. « Cadre doré ») : supplément au m² (ou au mètre) ou fixe. */
export const productOptions = mysqlTable("product_options", {
  id: int("id").autoincrement().primaryKey(),
  productId: int("productId").notNull().references(() => products.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 100 }).notNull(),
  surchargeType: mysqlEnum("surchargeType", ["per_m2", "fixed"]).notNull(),
  amountTnd: decimal("amountTnd", { precision: 10, scale: 3 }).notNull(),
  position: int("position").notNull().default(0),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => ({
  productIdx: index("product_options_product_idx").on(table.productId, table.position),
}));

export type ProductOption = typeof productOptions.$inferSelect;

/**
 * Fichiers envoyés par les vendeurs. Les binaires sont sur disque (storage/uploads),
 * MySQL ne conserve que la clé de stockage et les métadonnées.
 */
export const media = mysqlTable("media", {
  id: int("id").autoincrement().primaryKey(),
  ownerUserId: int("ownerUserId").notNull(),
  shopId: int("shopId"),
  productId: int("productId"),
  kind: mysqlEnum("kind", ["image", "video"]).notNull(),
  storageKey: varchar("storageKey", { length: 191 }).notNull().unique(),
  mimeType: varchar("mimeType", { length: 64 }).notNull(),
  sizeBytes: int("sizeBytes").notNull(),
  originalName: varchar("originalName", { length: 191 }),
  position: int("position").notNull().default(0),
  isPrimary: int("isPrimary").notNull().default(0),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type Media = typeof media.$inferSelect;

export const cartItems = mysqlTable("cart_items", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  productId: int("productId").notNull(),
  quantity: int("quantity").notNull().default(1),
  selectedColor: varchar("selectedColor", { length: 64 }),
  personalization: text("personalization"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const favoriteProducts = mysqlTable("favorite_products", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  productId: int("productId"),
  productSlug: varchar("productSlug", { length: 191 }).notNull(),
  productName: varchar("productName", { length: 191 }).notNull(),
  imageUrl: text("imageUrl").notNull(),
  priceTnd: decimal("priceTnd", { precision: 10, scale: 2 }).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => ({
  userProductUnique: unique("favorites_user_product").on(table.userId, table.productSlug),
}));

export const followedShops = mysqlTable("followed_shops", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  shopId: int("shopId"),
  shopSlug: varchar("shopSlug", { length: 191 }).notNull(),
  shopName: varchar("shopName", { length: 191 }).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => ({
  userShopUnique: unique("followed_user_shop").on(table.userId, table.shopSlug),
}));

export const orders = mysqlTable("orders", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  totalTnd: decimal("totalTnd", { precision: 10, scale: 2 }).notNull(),
  status: mysqlEnum("status", ["pending", "processing", "shipped", "delivered", "cancelled"]).default("pending").notNull(),
  shippingName: varchar("shippingName", { length: 191 }).notNull(),
  shippingPhone: varchar("shippingPhone", { length: 64 }).notNull(),
  shippingAddress: text("shippingAddress").notNull(),
  shippingCity: varchar("shippingCity", { length: 128 }).notNull(),
  shippingNote: text("shippingNote"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const commissions = mysqlTable("commissions", {
  id: int("id").autoincrement().primaryKey(),
  orderId: int("orderId").notNull(),
  shopId: int("shopId"),
  shopSlug: varchar("shopSlug", { length: 191 }).notNull(),
  grossTnd: decimal("grossTnd", { precision: 10, scale: 2 }).notNull(),
  commissionTnd: decimal("commissionTnd", { precision: 10, scale: 2 }).notNull(),
  vendorPayoutTnd: decimal("vendorPayoutTnd", { precision: 10, scale: 2 }).notNull(),
  status: mysqlEnum("status", ["pending", "settled", "refunded"]).default("pending").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const orderItems = mysqlTable("order_items", {
  id: int("id").autoincrement().primaryKey(),
  orderId: int("orderId").notNull(),
  productId: int("productId"),
  shopId: int("shopId"),
  productSlug: varchar("productSlug", { length: 191 }).notNull(),
  productName: varchar("productName", { length: 191 }).notNull(),
  shopSlug: varchar("shopSlug", { length: 191 }).notNull(),
  shopName: varchar("shopName", { length: 191 }).notNull(),
  quantity: int("quantity").notNull(),
  unitPriceTnd: decimal("unitPriceTnd", { precision: 10, scale: 2 }).notNull(),
  selectedColor: varchar("selectedColor", { length: 64 }),
  personalization: text("personalization"),
  // Instantané FIGÉ du calcul sur mesure (NULL pour un produit à prix fixe)
  pricingMode: varchar("pricingMode", { length: 16 }),
  widthCm: int("widthCm"),
  heightCm: int("heightCm"),
  areaM2: decimal("areaM2", { precision: 10, scale: 4 }),
  billedAreaM2: decimal("billedAreaM2", { precision: 10, scale: 4 }),
  appliedUnitPriceTnd: decimal("appliedUnitPriceTnd", { precision: 10, scale: 3 }),
  // [{ name, surchargeType, amountTnd }] copiés au moment de la commande
  optionsJson: text("optionsJson"),
  lineTotalTnd: decimal("lineTotalTnd", { precision: 10, scale: 2 }),
  // Néon personnalisé (pricingMode = "neon") : copie FIGÉE du texte, du style et du détail du prix
  neonText: varchar("neonText", { length: 255 }),
  neonScript: varchar("neonScript", { length: 8 }),
  neonFont: varchar("neonFont", { length: 32 }),
  neonColorName: varchar("neonColorName", { length: 32 }),
  neonColorHex: varchar("neonColorHex", { length: 7 }),
  neonSize: varchar("neonSize", { length: 8 }),
  neonSupport: varchar("neonSupport", { length: 16 }),
  neonOutdoor: int("neonOutdoor"),
  neonDetailsJson: text("neonDetailsJson"),
  // Statut de préparation propre au vendeur de la ligne (commandes multi-boutiques)
  fulfillmentStatus: mysqlEnum("fulfillmentStatus", ["pending", "processing", "shipped", "delivered", "cancelled"]).default("pending").notNull(),
});

/** Historique des changements de statut d'une commande (global ou propre à une boutique). */
export const orderStatusHistory = mysqlTable("order_status_history", {
  id: int("id").autoincrement().primaryKey(),
  orderId: int("orderId").notNull(),
  shopId: int("shopId"),
  fromStatus: varchar("fromStatus", { length: 32 }),
  toStatus: varchar("toStatus", { length: 32 }).notNull(),
  changedByUserId: int("changedByUserId"),
  changedByRole: varchar("changedByRole", { length: 16 }).notNull(),
  note: text("note"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

/** Paramètres du marketplace modifiables par l'administration (clé / valeur JSON). */
export const marketplaceSettings = mysqlTable("marketplace_settings", {
  key: varchar("key", { length: 64 }).primaryKey(),
  value: text("value").notNull(),
  updatedByUserId: int("updatedByUserId"),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export const addresses = mysqlTable("addresses", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  label: varchar("label", { length: 64 }).notNull(),
  recipientName: varchar("recipientName", { length: 191 }).notNull(),
  phone: varchar("phone", { length: 64 }).notNull(),
  addressLine: text("addressLine").notNull(),
  city: varchar("city", { length: 128 }).notNull(),
  postalCode: varchar("postalCode", { length: 32 }),
  isDefault: int("isDefault").notNull().default(0),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const reviews = mysqlTable("reviews", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  orderId: int("orderId").notNull(),
  productId: int("productId"),
  productSlug: varchar("productSlug", { length: 191 }).notNull(),
  productName: varchar("productName", { length: 191 }).notNull(),
  shopSlug: varchar("shopSlug", { length: 191 }).notNull(),
  rating: int("rating").notNull(),
  // A-10c (ajouts) : avis par LIGNE de commande, 3 critères, variante achetée et auteur figés à l'envoi
  orderItemId: int("orderItemId"),
  qualityRating: tinyint("qualityRating"),
  conformityRating: tinyint("conformityRating"),
  deliveryRating: tinyint("deliveryRating"),
  purchasedVariant: varchar("purchasedVariant", { length: 255 }),
  isCustom: int("isCustom").default(0).notNull(),
  // NULL = avis anonyme (« Client vérifié ») : ni nom ni gouvernorat enregistrés
  authorDisplayName: varchar("authorDisplayName", { length: 64 }),
  authorGovernorate: varchar("authorGovernorate", { length: 64 }),
  body: text("body").notNull(),
  // Réponse publique et unique de l'atelier
  vendorReply: text("vendorReply"),
  vendorReplyAt: timestamp("vendorReplyAt"),
  vendorReplyUserId: int("vendorReplyUserId"),
  status: mysqlEnum("status", ["pending", "published", "rejected"]).default("pending").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => ({
  userOrderProductUnique: unique("reviews_user_order_product").on(table.userId, table.orderId, table.productSlug),
  orderItemUnique: unique("reviews_order_item_unique").on(table.orderItemId),
}));

/** Photos d'avis (A-10c) : privées tant que l'avis n'est pas publié ; masquables par l'admin. */
export const reviewPhotos = mysqlTable("review_photos", {
  id: int("id").autoincrement().primaryKey(),
  reviewId: int("reviewId"),
  ownerUserId: int("ownerUserId").notNull(),
  storageKey: varchar("storageKey", { length: 191 }).notNull().unique(),
  mimeType: varchar("mimeType", { length: 64 }).notNull(),
  sizeBytes: int("sizeBytes").notNull(),
  position: int("position").default(0).notNull(),
  hiddenAt: timestamp("hiddenAt"),
  hiddenByUserId: int("hiddenByUserId"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

/** « Utile » : un vote par compte et par avis. */
export const reviewVotes = mysqlTable("review_votes", {
  id: int("id").autoincrement().primaryKey(),
  reviewId: int("reviewId").notNull(),
  userId: int("userId").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => ({
  reviewUserUnique: unique("review_votes_unique").on(table.reviewId, table.userId),
}));

/** « Signaler » : un signalement par compte et par avis, traité dans la console admin. */
export const reviewReports = mysqlTable("review_reports", {
  id: int("id").autoincrement().primaryKey(),
  reviewId: int("reviewId").notNull(),
  userId: int("userId").notNull(),
  reason: varchar("reason", { length: 500 }).notNull(),
  status: mysqlEnum("status", ["open", "resolved"]).default("open").notNull(),
  resolvedAt: timestamp("resolvedAt"),
  resolvedByUserId: int("resolvedByUserId"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => ({
  reviewUserUnique: unique("review_reports_unique").on(table.reviewId, table.userId),
}));

export const conversations = mysqlTable("conversations", {
  id: int("id").autoincrement().primaryKey(),
  clientId: int("clientId").notNull(),
  vendorId: int("vendorId").notNull(),
  shopId: int("shopId"),
  shopSlug: varchar("shopSlug", { length: 191 }).notNull(),
  shopName: varchar("shopName", { length: 191 }).notNull(),
  subject: varchar("subject", { length: 191 }),
  lastMessageAt: timestamp("lastMessageAt").defaultNow().notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => ({
  clientVendorShopUnique: unique("conversations_client_vendor_shop").on(table.clientId, table.vendorId, table.shopSlug),
}));

export const messages = mysqlTable("messages", {
  id: int("id").autoincrement().primaryKey(),
  conversationId: int("conversationId").notNull(),
  senderId: int("senderId").notNull(),
  body: text("body").notNull(),
  readAt: timestamp("readAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

/** Offre « Néon personnalisé » d'une boutique (une ligne par boutique ; contenu validé par shared/neon.ts). */
export const neonOffers = mysqlTable("neon_offers", {
  shopId: int("shopId").primaryKey(),
  enabled: int("enabled").notNull().default(0),
  // [{ code: "S", widthCm: 50, priceTnd: 180 }, …]
  sizesJson: text("sizesJson").notNull(),
  includedLetters: int("includedLetters").notNull().default(10),
  extraLetterPriceTnd: decimal("extraLetterPriceTnd", { precision: 10, scale: 3 }).notNull().default("0"),
  // ["warm_white", "pink", …] : clés de la palette fixe
  colorsJson: text("colorsJson").notNull(),
  // [{ code: "cut" | "rect" | "none", surchargeTnd }]
  supportsJson: text("supportsJson").notNull(),
  outdoorEnabled: int("outdoorEnabled").notNull().default(0),
  outdoorSurchargeType: mysqlEnum("outdoorSurchargeType", ["percent", "fixed"]).notNull().default("percent"),
  outdoorSurchargeValue: decimal("outdoorSurchargeValue", { precision: 10, scale: 3 }).notNull().default("0"),
  arabicEnabled: int("arabicEnabled").notNull().default(0),
  productionDaysMin: int("productionDaysMin"),
  productionDaysMax: int("productionDaysMax"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

/** « Envoyer mon logo pour un devis » (clients connectés). */
export const neonQuoteRequests = mysqlTable("neon_quote_requests", {
  id: int("id").autoincrement().primaryKey(),
  shopId: int("shopId").notNull(),
  userId: int("userId").notNull(),
  mediaId: int("mediaId"),
  message: text("message"),
  phone: varchar("phone", { length: 64 }),
  sizeCode: varchar("sizeCode", { length: 8 }),
  outdoor: int("outdoor").notNull().default(0),
  status: mysqlEnum("status", ["new", "seen", "answered", "closed"]).notNull().default("new"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});
