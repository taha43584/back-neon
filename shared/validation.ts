import { z } from "zod";

/** Règles de validation partagées entre le navigateur et le serveur (messages en français). */

export const VENDOR_TERMS_PATH = "/conditions-vendeurs";

const PHONE_PATTERN = /^\+?[0-9\s().-]{8,20}$/;
const countDigits = (value: string) => value.replace(/\D/g, "").length;

const nameField = (label: string) =>
  z.string().trim()
    .min(2, `${label} doit comporter au moins 2 caractères`)
    .max(128, `${label} est trop long`);

export const phoneField = (label = "Le numéro de téléphone") =>
  z.string().trim()
    .regex(PHONE_PATTERN, `${label} est invalide (ex. +216 20 123 456)`)
    .refine((value) => countDigits(value) >= 8 && countDigits(value) <= 15, `${label} doit contenir entre 8 et 15 chiffres`);

export const emailField = z.string().trim()
  .min(1, "L'adresse e-mail est requise")
  .max(320, "L'adresse e-mail est trop longue")
  .email("Adresse e-mail invalide");

export const passwordField = z.string()
  .min(8, "Le mot de passe doit comporter au moins 8 caractères")
  .max(128, "Le mot de passe est trop long")
  .refine((value) => /[A-Za-z]/.test(value) && /[0-9]/.test(value), "Le mot de passe doit contenir au moins une lettre et un chiffre");

const passwordsMatch = <T extends { password: string; passwordConfirm: string }>(data: T) => data.password === data.passwordConfirm;
const passwordMismatch = { message: "Les mots de passe ne correspondent pas", path: ["passwordConfirm"] };

export const customerRegistrationSchema = z.object({
  firstName: nameField("Le prénom"),
  lastName: nameField("Le nom"),
  email: emailField,
  phone: phoneField(),
  city: z.string().trim().min(2, "La ville / localisation est requise").max(128, "La localisation est trop longue"),
  address: z.string().trim().min(5, "L'adresse de livraison doit comporter au moins 5 caractères").max(500, "L'adresse est trop longue"),
  password: passwordField,
  passwordConfirm: z.string().min(1, "Veuillez confirmer le mot de passe"),
}).refine(passwordsMatch, passwordMismatch);

export const vendorRegistrationSchema = z.object({
  firstName: nameField("Le prénom"),
  lastName: nameField("Le nom"),
  email: emailField,
  phone: phoneField(),
  city: z.string().trim().min(2, "La localisation est requise").max(128, "La localisation est trop longue"),
  shopName: z.string().trim().min(2, "Le nom de la boutique doit comporter au moins 2 caractères").max(191, "Le nom de la boutique est trop long"),
  whatsapp: phoneField("Le numéro WhatsApp"),
  password: passwordField,
  passwordConfirm: z.string().min(1, "Veuillez confirmer le mot de passe"),
  acceptTerms: z.boolean().refine((value) => value === true, "Vous devez accepter les conditions générales applicables aux vendeurs"),
}).refine(passwordsMatch, passwordMismatch);

export const profileUpdateSchema = z.object({
  firstName: nameField("Le prénom").optional(),
  lastName: nameField("Le nom").optional(),
  phone: phoneField().optional(),
  city: z.string().trim().min(2, "La ville est requise").max(128).optional(),
  address: z.string().trim().min(5, "L'adresse doit comporter au moins 5 caractères").max(500).optional(),
});

export type CustomerRegistrationInput = z.infer<typeof customerRegistrationSchema>;
export type VendorRegistrationInput = z.infer<typeof vendorRegistrationSchema>;

/** Transforme les erreurs zod en dictionnaire { champ: premier message }. */
export function fieldErrors(error: z.ZodError): Record<string, string> {
  const result: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? "form");
    if (!result[key]) result[key] = issue.message;
  }
  return result;
}
