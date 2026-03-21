module.exports = {
  up(pgm) {
    pgm.addColumn("cases", {
      opposing_party: {
        type: "text",
        notNull: false,
        default: null
      }
    });
  },

  down(pgm) {
    pgm.dropColumn("cases", "opposing_party");
  }
};
