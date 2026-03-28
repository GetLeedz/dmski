module.exports = {
  up(pgm) {
    pgm.addColumn("users", {
      password_change_required: {
        type: "boolean",
        notNull: true,
        default: false
      }
    });
  },
  down(pgm) {
    pgm.dropColumn("users", "password_change_required");
  }
};
