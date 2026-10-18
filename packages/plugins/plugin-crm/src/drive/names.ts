export type NameProblem = "empty" | "too_long" | "uuid" | "issue_key" | "drive_id" | "illegal_chars";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISSUE_KEY_REGEX = /^[A-Za-z][A-Za-z0-9]*-\d+$/;
const DRIVE_ID_CHARS = /^[A-Za-z0-9_-]+$/;
const DRIVE_URL_REGEX = /(drive\.google\.com|docs\.google\.com)/;
const ILLEGAL_CHARS = /[\\/\x00-\x1f\x7f-\x9f]/;

export function cleanFolderName(raw: string): string {
  return raw.normalize("NFC").trim().replace(/\s+/g, " ");
}

export function checkFolderName(name: string): NameProblem | null {
  if (!name || !name.trim()) return "empty";
  if (name.length > 200) return "too_long";
  if (UUID_REGEX.test(name)) return "uuid";
  if (ISSUE_KEY_REGEX.test(name)) return "issue_key";
  if (DRIVE_URL_REGEX.test(name) || (!name.includes(" ") && name.length >= 20 && DRIVE_ID_CHARS.test(name) && /[\dA-Z]/.test(name.slice(1)))) {
    return "drive_id";
  }
  if (ILLEGAL_CHARS.test(name)) return "illegal_chars";
  return null;
}

export function folderKey(name: string): string {
  const cleaned = cleanFolderName(name).normalize("NFKD").replace(/[̀-ͯ]/g, "");
  return cleaned.toLowerCase().replace(/[^a-z0-9]/g, "");
}
