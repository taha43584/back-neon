export type CatalogProduct = {
  slug: string;
  name: string;
  shopSlug: string;
  shopName: string;
  price: string;
  image: string;
  badge: string;
  tint: string;
  category: string;
  description: string;
  material: string;
  dimensions: string;
  personalization: string;
  delivery: string;
  rating: number | null;
  reviewCount: number;
};

export type CatalogShop = {
  slug: string;
  name: string;
  tagline: string;
  initials: string;
  color: string;
  cover: string;
  rating: number | null;
  reviewCount: number;
  sales: number;
  productCount: number;
  about: string;
};

const asset = (name: string) => `/manus-storage/${name}`;

export const catalogShops: CatalogShop[] = [
  {
    slug: "nova-decor",
    name: "Nova Decor",
    tagline: "Miroirs & pièces lumineuses",
    initials: "ND",
    color: "bg-[#d8bfa9]",
    cover: asset("neon-beauty_2c8ad21c.jpg"),
    rating: null,
    reviewCount: 0,
    sales: 0,
    productCount: 2,
    about: "Nova Decor imagine des pièces lumineuses pour les intérieurs qui aiment sortir du cadre.",
  },
  {
    slug: "lightcraft",
    name: "LightCraft",
    tagline: "Néons pour lieux de vie",
    initials: "LC",
    color: "bg-[#d7c7dc]",
    cover: asset("neon-sign_70151d7b.webp"),
    rating: null,
    reviewCount: 0,
    sales: 0,
    productCount: 2,
    about: "LightCraft crée des enseignes et néons personnalisés pour les marques, cafés et espaces créatifs.",
  },
  {
    slug: "woodart-tn",
    name: "WoodArt TN",
    tagline: "Bois, MDF & formes libres",
    initials: "WA",
    color: "bg-[#c7d1bd]",
    cover: asset("wall-art_c97c84e3.jpg"),
    rating: null,
    reviewCount: 0,
    sales: 0,
    productCount: 2,
    about: "WoodArt TN travaille le bois et le MDF pour créer des reliefs muraux chaleureux et durables.",
  },
  {
    slug: "decorpanel",
    name: "DecorPanel",
    tagline: "Murs texturés & panneaux",
    initials: "DP",
    color: "bg-[#d6c6af]",
    cover: asset("hero-salon_c92b3156.jpg"),
    rating: null,
    reviewCount: 0,
    sales: 0,
    productCount: 2,
    about: "DecorPanel accompagne les projets professionnels avec des panneaux décoratifs pensés pour durer.",
  },
];

export const catalogProducts: CatalogProduct[] = [
  {
    slug: "miroir-led-ondule",
    name: "Miroir LED ondulé",
    shopSlug: "nova-decor",
    shopName: "Nova Decor",
    price: "289 TND",
    image: asset("neon-beauty_2c8ad21c.jpg"),
    badge: "Bestseller",
    tint: "bg-[#f5ede7]",
    category: "Miroirs LED",
    description: "Un miroir aux lignes souples qui apporte une lumière douce et une vraie présence à votre espace.",
    material: "Miroir haute réflexion, contour finition satinée",
    dimensions: "80 × 60 cm",
    personalization: "Choix de la température de lumière sur demande",
    delivery: "Expédition sous 5 à 7 jours ouvrés",
    rating: null,
    reviewCount: 0,
  },
  {
    slug: "panneau-mural-sculpte",
    name: "Panneau mural sculpté",
    shopSlug: "woodart-tn",
    shopName: "WoodArt TN",
    price: "175 TND",
    image: asset("wall-art_c97c84e3.jpg"),
    badge: "Fait main",
    tint: "bg-[#e8e2d8]",
    category: "Décoration murale",
    description: "Un panneau texturé inspiré des formes naturelles, réalisé en atelier pour réchauffer un mur vide.",
    material: "MDF sculpté et finition mate",
    dimensions: "90 × 60 cm",
    personalization: "Dimensions et teinte personnalisables",
    delivery: "Expédition sous 7 à 10 jours ouvrés",
    rating: null,
    reviewCount: 0,
  },
  {
    slug: "enseigne-lumineuse-sur-mesure",
    name: "Enseigne lumineuse sur mesure",
    shopSlug: "lightcraft",
    shopName: "LightCraft",
    price: "à partir de 220 TND",
    image: asset("neon-sign_70151d7b.webp"),
    badge: "Personnalisable",
    tint: "bg-[#ebe2f1]",
    category: "LED Néon",
    description: "Une enseigne lumineuse dessinée à partir de votre mot, logo ou signature de marque.",
    material: "Acrylique, LED basse consommation et alimentation sécurisée",
    dimensions: "Format défini selon votre message",
    personalization: "Texte, couleur, police et dimensions sur mesure",
    delivery: "Maquette envoyée avant fabrication",
    rating: null,
    reviewCount: 0,
  },
  {
    slug: "ambiance-salon-naturel",
    name: "Ambiance salon naturel",
    shopSlug: "decorpanel",
    shopName: "DecorPanel",
    price: "420 TND",
    image: asset("hero-salon_c92b3156.jpg"),
    badge: "Nouveau",
    tint: "bg-[#e4e9df]",
    category: "Décoration salons",
    description: "Une composition de panneaux et d'éléments décoratifs pour créer une atmosphère calme et accueillante.",
    material: "Panneaux décoratifs, bois clair et accessoires de fixation",
    dimensions: "Composition modulable jusqu'à 180 × 120 cm",
    personalization: "Étude de composition disponible pour les professionnels",
    delivery: "Livraison sur rendez-vous selon la composition",
    rating: null,
    reviewCount: 0,
  },
  {
    slug: "miroir-led-rond",
    name: "Miroir LED rond studio",
    shopSlug: "nova-decor",
    shopName: "Nova Decor",
    price: "245 TND",
    image: asset("neon-beauty_2c8ad21c.jpg"),
    badge: "Nouveau",
    tint: "bg-[#f1e7dc]",
    category: "Miroirs LED",
    description: "Un miroir rond et minimal pour un coin beauté, une entrée ou un espace professionnel.",
    material: "Miroir argenté et halo LED",
    dimensions: "Diamètre 70 cm",
    personalization: "Interrupteur tactile en option",
    delivery: "Expédition sous 5 à 7 jours ouvrés",
    rating: null,
    reviewCount: 0,
  },
  {
    slug: "neon-coffee-time",
    name: "LED Néon Coffee Time",
    shopSlug: "lightcraft",
    shopName: "LightCraft",
    price: "260 TND",
    image: asset("neon-sign_70151d7b.webp"),
    badge: "Coup de cœur",
    tint: "bg-[#eee4eb]",
    category: "Cafés & restaurants",
    description: "Une signature lumineuse chaleureuse pour comptoir, coffee shop ou coin café à la maison.",
    material: "Acrylique transparent et LED blanc chaud",
    dimensions: "55 × 25 cm",
    personalization: "Message différent disponible sur demande",
    delivery: "Préparation sous 5 jours ouvrés",
    rating: null,
    reviewCount: 0,
  },
  {
    slug: "relief-mural-archi",
    name: "Relief mural Archi",
    shopSlug: "woodart-tn",
    shopName: "WoodArt TN",
    price: "198 TND",
    image: asset("wall-art_c97c84e3.jpg"),
    badge: "Fait main",
    tint: "bg-[#e7e4da]",
    category: "MDF / CNC",
    description: "Un relief géométrique fabriqué en petites séries pour donner du rythme aux murs contemporains.",
    material: "MDF teinté dans la masse",
    dimensions: "100 × 50 cm",
    personalization: "Teinte et découpe personnalisables",
    delivery: "Expédition sous 8 à 12 jours ouvrés",
    rating: null,
    reviewCount: 0,
  },
  {
    slug: "panneaux-atelier-calme",
    name: "Panneaux Atelier Calme",
    shopSlug: "decorpanel",
    shopName: "DecorPanel",
    price: "315 TND",
    image: asset("hero-salon_c92b3156.jpg"),
    badge: "Professionnels",
    tint: "bg-[#e1e8df]",
    category: "Décoration bureaux",
    description: "Des panneaux texturés pour structurer un accueil, une salle d'attente ou un open space.",
    material: "Panneau décoratif acoustique et bois",
    dimensions: "120 × 80 cm",
    personalization: "Étude sur plan disponible",
    delivery: "Livraison et pose sur devis",
    rating: null,
    reviewCount: 0,
  },
];

export function getProductBySlug(slug: string) {
  return catalogProducts.find((product) => product.slug === slug);
}

export function getShopBySlug(slug: string) {
  return catalogShops.find((shop) => shop.slug === slug);
}

export function getProductsByShop(shopSlug: string) {
  return catalogProducts.filter((product) => product.shopSlug === shopSlug);
}
