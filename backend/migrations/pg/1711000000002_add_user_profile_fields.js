module.exports = {
  up(pgm) {
    pgm.addColumn("users", {
      function_label: {
        type: "text",
        notNull: false,
        default: null
      }
    });
    pgm.addColumn("users", {
      case_id: {
        type: "text",
        notNull: false,
        default: null,
        references: "cases(id)",
        onDelete: "set null"
      }
    });
    pgm.addColumn("users", {
      mobile: {
        type: "text",
        notNull: false,
        default: null
      }
    });
  },

  down(pgm) {
    pgm.dropColumn("users", "mobile");
    pgm.dropColumn("users", "case_id");
    pgm.dropColumn("users", "function_label");
  }
};
