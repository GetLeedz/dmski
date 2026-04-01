exports.up = async (pgm) => {
  await pgm.sql(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS invited_at TIMESTAMPTZ;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS login_count INTEGER NOT NULL DEFAULT 0;
  `);
};

exports.down = async (pgm) => {
  await pgm.sql(`
    ALTER TABLE users DROP COLUMN IF EXISTS invited_at;
    ALTER TABLE users DROP COLUMN IF EXISTS last_login_at;
    ALTER TABLE users DROP COLUMN IF EXISTS login_count;
  `);
};
