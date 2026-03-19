module.exports = {
  up(pgm) {
    pgm.createExtension("pgcrypto", { ifNotExists: true });

    pgm.createTable("users", {
      id: {
        type: "uuid",
        primaryKey: true,
        default: pgm.func("gen_random_uuid()")
      },
      email: {
        type: "text",
        notNull: true,
        unique: true
      },
      password_hash: {
        type: "text",
        notNull: true
      },
      created_at: {
        type: "timestamp",
        notNull: true,
        default: pgm.func("CURRENT_TIMESTAMP")
      }
    });
  },

  down(pgm) {
    pgm.dropTable("users", { ifExists: true });
  }
};
