/**
 * Password rules:
 * - Minimum 10 characters
 * - At least 1 uppercase letter
 * - At least 1 number
 * - At least 1 special character
 */
const PASSWORD_REGEX = /^(?=.*[A-Z])(?=.*[0-9])(?=.*[^A-Za-z0-9]).{10,}$/;
const PASSWORD_HINT = "Passwort: mind. 10 Zeichen, 1 Grossbuchstabe, 1 Zahl, 1 Sonderzeichen (!@#$...)";

function validatePassword(password) {
  return PASSWORD_REGEX.test(password);
}

module.exports = { validatePassword, PASSWORD_HINT };
