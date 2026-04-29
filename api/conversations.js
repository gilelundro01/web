// GET  /api/conversations          → list user's conversations (summaries)
// POST /api/conversations          → create new empty conversation
//
// Anonymous user identification via HttpOnly cookie `chatuid`.

'use strict';

const {
  ensureUid,
  listConversations,
  createConversation,
  jsonOk,
  jsonError,
  readBody,
  kvConfigured,
} = require('./_lib');

module.exports = async (req, res) => {
  try {
    const { uid } = ensureUid(req, res);

    if (!kvConfigured()) {
      // Soft-fail: return empty list with a hint header so frontend can warn.
      res.setHeader('X-KV-Configured', 'false');
    } else {
      res.setHeader('X-KV-Configured', 'true');
    }

    if (req.method === 'GET') {
      const items = await listConversations(uid);
      return jsonOk(res, { conversations: items });
    }

    if (req.method === 'POST') {
      const body = readBody(req) || {};
      const conv = await createConversation(uid, {
        title: body.title,
        model: body.model,
      });
      return jsonOk(res, {
        conversation: {
          id: conv.id,
          title: conv.title,
          updatedAt: conv.updatedAt,
          model: conv.model,
          messages: [],
        },
      });
    }

    return jsonError(res, 405, 'Method not allowed');
  } catch (e) {
    return jsonError(res, 500, (e && e.message) || String(e));
  }
};
