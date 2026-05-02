/**
 * validator.js  (v3)
 * ==================
 * Pure validation logic — no DOM dependencies.
 *
 * Naming convention enforced:  mmm_dd_yyyy
 *   VALID   →  apr_01_2024.jpg
 *   INVALID →  april_01_2024.jpg  (full month name)
 *   INVALID →  Apr_01_2024.jpg    (uppercase first letter)
 *   INVALID →  apr_1_2024.jpg     (single-digit day)
 *   INVALID →  APR_1_24.jpg       (uppercase + short year + single day)
 *
 * v3: every return now includes `errorType` for the UI "Error Type" column.
 */

(function (global) {
  "use strict";

  const FILENAME_REGEX = /^([a-z]{3})_(\d{2})_(\d{4})$/;

  const VALID_MONTHS = new Set([
    "jan","feb","mar","apr","may","jun",
    "jul","aug","sep","oct","nov","dec",
  ]);

  function stripExtension(filename) {
    const lastDot = filename.lastIndexOf(".");
    return lastDot !== -1 ? filename.slice(0, lastDot) : filename;
  }

  /**
   * Validates a single filename against mmm_dd_yyyy rules.
   * @param {string} filename
   * @returns {{ valid: boolean, errorType: string, reason: string }}
   *
   * errorType for valid:   "VALID"
   * errorType for invalid: "CASE_ERROR" | "FORMAT_ERROR" | "STRUCTURE_ERROR" |
   *                        "MONTH_ERROR" | "DAY_ERROR" | "YEAR_ERROR" | "REGEX_ERROR"
   */
  function validateFilename(filename) {
    const stem = stripExtension(filename);

    if (/[A-Z]/.test(stem)) {
      return {
        valid: false,
        errorType: "CASE_ERROR",
        reason: "Uppercase letters are not allowed — use all lowercase (e.g. apr_01_2024)",
      };
    }

    if (!stem.includes("_")) {
      return {
        valid: false,
        errorType: "FORMAT_ERROR",
        reason: "Must use underscore ( _ ) separators — e.g. apr_01_2024",
      };
    }

    const parts = stem.split("_");
    if (parts.length !== 3) {
      return {
        valid: false,
        errorType: "STRUCTURE_ERROR",
        reason: `Must have exactly 3 parts separated by _ (got ${parts.length}) — expected mmm_dd_yyyy`,
      };
    }

    const [mon, day, yr] = parts;

    if (!/^[a-z]{3}$/.test(mon)) {
      return {
        valid: false,
        errorType: "MONTH_ERROR",
        reason: `Month must be exactly 3 lowercase letters (got "${mon}") — e.g. apr, jan, dec`,
      };
    }

    if (!VALID_MONTHS.has(mon)) {
      return {
        valid: false,
        errorType: "MONTH_ERROR",
        reason: `"${mon}" is not a valid month abbreviation — use jan feb mar apr may jun jul aug sep oct nov dec`,
      };
    }

    if (!/^\d{2}$/.test(day)) {
      return {
        valid: false,
        errorType: "DAY_ERROR",
        reason: `Day must be exactly 2 digits (got "${day}") — use leading zero e.g. 01 not 1`,
      };
    }

    const dayNum = parseInt(day, 10);
    if (dayNum < 1 || dayNum > 31) {
      return {
        valid: false,
        errorType: "DAY_ERROR",
        reason: `Day "${day}" is out of range — must be 01–31`,
      };
    }

    if (!/^\d{4}$/.test(yr)) {
      return {
        valid: false,
        errorType: "YEAR_ERROR",
        reason: `Year must be exactly 4 digits (got "${yr}") — e.g. 2024 not 24`,
      };
    }

    if (!FILENAME_REGEX.test(stem)) {
      return {
        valid: false,
        errorType: "REGEX_ERROR",
        reason: "Does not match required format: mmm_dd_yyyy",
      };
    }

    return {
      valid: true,
      errorType: "VALID",
      reason: "Matches mmm_dd_yyyy format",
    };
  }

  global.Validator = { validateFilename, stripExtension, VALID_MONTHS, FILENAME_REGEX };
})(window);
