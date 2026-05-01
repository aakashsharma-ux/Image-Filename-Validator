/**
 * validator.js
 * ============
 * Pure validation logic — no DOM dependencies.
 * Can be imported/tested independently of the UI.
 *
 * Naming convention enforced:  mmm_dd_yyyy
 * Examples:
 *   VALID   →  apr_01_2024.jpg
 *   INVALID →  April_01_2024.jpg  (full month)
 *   INVALID →  Apr_01_2024.jpg    (uppercase)
 *   INVALID →  apr_1_2024.jpg     (single-digit day)
 *   INVALID →  APR_1_24.jpg       (uppercase + short year + single day)
 */

(function (global) {
  "use strict";

  /* -------------------------------------------------------
     Constants
  ------------------------------------------------------- */

  /**
   * Strict regex for the filename stem (no extension).
   * Breakdown:
   *   ^          – start of string
   *   ([a-z]{3}) – exactly 3 lowercase letters  (month)
   *   _          – literal underscore separator
   *   (\d{2})    – exactly 2 digits              (day)
   *   _          – literal underscore separator
   *   (\d{4})    – exactly 4 digits              (year)
   *   $          – end of string
   */
  const FILENAME_REGEX = /^([a-z]{3})_(\d{2})_(\d{4})$/;

  /** All valid 3-letter lowercase month abbreviations. */
  const VALID_MONTHS = new Set([
    "jan", "feb", "mar", "apr", "may", "jun",
    "jul", "aug", "sep", "oct", "nov", "dec",
  ]);

  /* -------------------------------------------------------
     Helpers
  ------------------------------------------------------- */

  /**
   * Strips the file extension from a filename.
   * "apr_01_2024.jpg"  →  "apr_01_2024"
   * "noextension"      →  "noextension"
   *
   * @param {string} filename
   * @returns {string}
   */
  function stripExtension(filename) {
    const lastDot = filename.lastIndexOf(".");
    return lastDot !== -1 ? filename.slice(0, lastDot) : filename;
  }

  /* -------------------------------------------------------
     Core validation function
  ------------------------------------------------------- */

  /**
   * Validates a single filename against mmm_dd_yyyy rules.
   *
   * @param {string} filename - The full filename including extension.
   * @returns {{ valid: boolean, reason: string }}
   */
  function validateFilename(filename) {
    const stem = stripExtension(filename); // work without extension

    // ── 1. Quick check: any uppercase letters? ──────────────
    if (/[A-Z]/.test(stem)) {
      return {
        valid: false,
        reason: "Uppercase letters are not allowed — use all lowercase",
      };
    }

    // ── 2. Must contain underscores ─────────────────────────
    if (!stem.includes("_")) {
      return {
        valid: false,
        reason: 'Must use underscore ( _ ) separators — e.g. apr_01_2024',
      };
    }

    // ── 3. Split and verify part count ──────────────────────
    const parts = stem.split("_");
    if (parts.length !== 3) {
      return {
        valid: false,
        reason: `Must have exactly 3 parts separated by _ (got ${parts.length})`,
      };
    }

    const [mon, day, yr] = parts;

    // ── 4. Month: exactly 3 lowercase letters ───────────────
    if (!/^[a-z]{3}$/.test(mon)) {
      return {
        valid: false,
        reason: `Month must be exactly 3 lowercase letters (got "${mon}")`,
      };
    }

    // ── 5. Month: must be a real calendar abbreviation ──────
    if (!VALID_MONTHS.has(mon)) {
      return {
        valid: false,
        reason: `"${mon}" is not a valid month abbreviation (jan–dec)`,
      };
    }

    // ── 6. Day: exactly 2 digits ────────────────────────────
    if (!/^\d{2}$/.test(day)) {
      return {
        valid: false,
        reason: `Day must be exactly 2 digits (got "${day}") — use leading zero, e.g. 01`,
      };
    }

    // ── 7. Day: numeric range 01–31 ─────────────────────────
    const dayNum = parseInt(day, 10);
    if (dayNum < 1 || dayNum > 31) {
      return {
        valid: false,
        reason: `Day "${day}" is out of range — must be 01–31`,
      };
    }

    // ── 8. Year: exactly 4 digits ───────────────────────────
    if (!/^\d{4}$/.test(yr)) {
      return {
        valid: false,
        reason: `Year must be exactly 4 digits (got "${yr}")`,
      };
    }

    // ── 9. Full regex guard (catches any edge cases) ────────
    if (!FILENAME_REGEX.test(stem)) {
      return {
        valid: false,
        reason: 'Does not match required format: mmm_dd_yyyy',
      };
    }

    // ── All checks passed ────────────────────────────────────
    return {
      valid: true,
      reason: "Matches mmm_dd_yyyy format",
    };
  }

  /* -------------------------------------------------------
     Public API
  ------------------------------------------------------- */
  global.Validator = {
    validateFilename,
    stripExtension,
    VALID_MONTHS,
    FILENAME_REGEX,
  };
})(window);
