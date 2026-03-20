module.exports = {
  up(pgm) {
    pgm.addColumn("cases", {
      protected_person_name: {
        type: "text",
        notNull: false,
        default: null
      }
    });
  },

  down(pgm) {
    pgm.dropColumn("cases", "protected_person_name");
  }
};
