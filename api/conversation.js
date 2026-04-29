// GET    /api/conversation?id=<id>   → load full conversation (with messages)
// DELETE /api/conversation?id=<id>   → delete
// PATCH  /api/conversation?id=<id>   → rename (body: { title })

'use strict';

const {
  ensureUid,
  getConversation,
  deleteUserConversation,
  renameUserConversation,
  jsonOk,
  jsonError,
  readBody,
} = require('./_lib');

function parseId(req) {
  try {
    const u = new URL(req.url, 'http://x');
    return u.searchParams.get('id') || '';
  } catch (_) {
    return '';
  }
}

module.exports = async (req, res) => {
  try {
    const { uid } = ensureUid(req, res);
    const id = parseId(req);
    if (!id) return jsonError(res, 400, 'Param `id` wajib.');

    if (req.method === 'GET') {
      const conv = await getConversation(id);
      if (!conv) return jsonError(res, 404, 'Conversation tidak ditemukan.');
      if (conv.ownerUid && conv.ownerUid !== uid) {
        return jsonError(res, 403, 'Akses ditolak.');
      }
      // Strip ownerUid before sending to client.
      return jsonOk(res, {
        conversation: {
          id: conv.id,
          title: conv.title,
          model: conv.model,
          createdAt: conv.createdAt,
          updatedAt: conv.updatedAt,
          messages: conv.messages || [],
        },
      });
    }

    if (req.method === 'DELETE') {
      await deleteUserConversation(uid, id);
      return jsonOk(res, {});
    }

    if (req.method === 'PATCH' || req.method === 'POST') {
      // Some hosts strip PATCH; accept POST with body { title } too.
      const body = readBody(req) || {};
      if (typeof body.title !== 'string' || !body.title.trim()) {
        return jsonError(res, 400, 'Field `title` wajib.');
      }
      const conv = await renameUserConversation(uid, id, body.title);
      return jsonOk(res, {
        conversation: {
          id: conv.id,
          title: conv.title,
          updatedAt: conv.updatedAt,
        },
      });
    }

    return jsonError(res, 405, 'Method not allowed');
  } catch (e) {
    return jsonError(res, 500, (e && e.message) || String(e));
  }
};
