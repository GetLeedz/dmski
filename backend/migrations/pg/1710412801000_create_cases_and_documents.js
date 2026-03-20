module.exports = {
  up(pgm) {
    pgm.createTable("cases", {
      id: {
        type: "text",
        primaryKey: true
      },
      case_date: {
        type: "date",
        notNull: true
      },
      case_name: {
        type: "text",
        notNull: true
      },
      created_at: {
        type: "timestamp",
        notNull: true,
        default: pgm.func("CURRENT_TIMESTAMP")
      }
    });

    pgm.addConstraint("cases", "cases_id_len_chk", {
      check: "char_length(id) = 6"
    });

    pgm.createTable("case_documents", {
      id: {
        type: "uuid",
        primaryKey: true,
        default: pgm.func("gen_random_uuid()")
      },
      case_id: {
        type: "text",
        notNull: true,
        references: 'cases(id)',
        onDelete: "cascade"
      },
      original_name: {
        type: "text",
        notNull: true
      },
      stored_name: {
        type: "text",
        notNull: true
      },
      mime_type: {
        type: "text",
        notNull: true
      },
      size_bytes: {
        type: "integer",
        notNull: true
      },
      uploaded_at: {
        type: "timestamp",
        notNull: true,
        default: pgm.func("CURRENT_TIMESTAMP")
      }
    });

    pgm.createIndex("case_documents", ["case_id", "uploaded_at"]);
  },

  down(pgm) {
    pgm.dropTable("case_documents", { ifExists: true });
    pgm.dropTable("cases", { ifExists: true });
  }
};
