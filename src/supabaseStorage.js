const { createClient } = require("@supabase/supabase-js");

const BUCKET = "avatars";

let supabase = null;
function getClient() {
  if (!supabase) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_KEY;
    if (!url || !key) {
      throw new Error("SUPABASE_URL / SUPABASE_SERVICE_KEY belum diatur di environment variables");
    }
    supabase = createClient(url, key);
  }
  return supabase;
}

// Upload buffer foto, return public URL. fileName harus unik (pakai playerId + timestamp).
async function uploadAvatar(playerId, buffer, mimeType) {
  const client = getClient();
  const ext = mimeType === "image/png" ? "png" : "jpg";
  const fileName = `player-${playerId}-${Date.now()}.${ext}`;

  const { error } = await client.storage.from(BUCKET).upload(fileName, buffer, {
    contentType: mimeType,
    upsert: false,
  });
  if (error) throw new Error(`Gagal upload foto: ${error.message}`);

  const { data } = client.storage.from(BUCKET).getPublicUrl(fileName);
  return data.publicUrl;
}

module.exports = { uploadAvatar };
