import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./en.json";
import hi from "./hi.json";

export const SUPPORTED_LANGUAGES = [
  { code: "en", label: "EN", name: "English" },
  { code: "hi", label: "हिं", name: "हिंदी" },
];

const STORAGE_KEY = "foms_lang";

function getInitialLanguage() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "en" || saved === "hi") return saved;
  } catch (e) {
    console.warn("Failed to read language preference from localStorage", e);
  }
  return "en";
}

i18n
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      hi: { translation: hi },
    },
    lng: getInitialLanguage(),
    fallbackLng: "en",
    interpolation: { escapeValue: false },
    returnNull: false,
  });

export function setLanguage(lng) {
  i18n.changeLanguage(lng);
  try { localStorage.setItem(STORAGE_KEY, lng); } catch (e) { console.warn("Failed to persist language preference", e); }
}

export default i18n;
