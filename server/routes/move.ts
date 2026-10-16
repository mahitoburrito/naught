import { Hono } from "hono";
import {
  MoveError,
  bringHome,
  cancelMove,
  moveStateOf,
  planBringHome,
  planMoveOut,
  retryMove,
  startMove,
} from "../services/sessionMove";

export const moveRoutes = new Hono();

function reply(c: any, error: unknown) {
  if (error instanceof MoveError) return c.json({ error: error.message, refusals: error.refusals }, error.status);
  return c.json({ error: error instanceof Error ? error.message : "Unexpected error" }, 500);
}

moveRoutes.post("/:sessionId/move/plan", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  try {
    return c.json(await planMoveOut(c.req.param("sessionId"), {
      nodeId: typeof body.nodeId === "string" ? body.nodeId : undefined,
      includeIgnored: body.includeIgnored === true,
    }));
  } catch (error) {
    return reply(c, error);
  }
});

moveRoutes.post("/:sessionId/move/home/plan", async (c) => {
  try {
    return c.json(await planBringHome(c.req.param("sessionId")));
  } catch (error) {
    return reply(c, error);
  }
});

moveRoutes.post("/:sessionId/move", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  try {
    const result = await startMove(c.req.param("sessionId"), {
      nodeId: typeof body.nodeId === "string" ? body.nodeId : undefined,
      newNode: body.newNode && typeof body.newNode === "object" ? body.newNode : undefined,
      includeIgnored: body.includeIgnored === true,
      whenIdle: body.whenIdle === false && body.afterTurn !== true ? false : true,
    });
    return c.json(result, 202);
  } catch (error) {
    return reply(c, error);
  }
});

moveRoutes.post("/:sessionId/move/home", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  try {
    const result = await bringHome(c.req.param("sessionId"), {
      conflict: body.conflict === "overwrite" || body.conflict === "worktree" ? body.conflict : undefined,
      terminateNode: body.terminateNode !== false,
      whenIdle: body.whenIdle === false && body.afterTurn !== true ? false : true,
    });
    return c.json(result, 202);
  } catch (error) {
    return reply(c, error);
  }
});

moveRoutes.get("/:sessionId/move", (c) => {
  try {
    return c.json({ move: moveStateOf(c.req.param("sessionId")) ?? null });
  } catch (error) {
    return reply(c, error);
  }
});

moveRoutes.post("/:sessionId/move/retry", async (c) => {
  try {
    return c.json({ move: await retryMove(c.req.param("sessionId")) });
  } catch (error) {
    return reply(c, error);
  }
});

moveRoutes.post("/:sessionId/move/cancel", async (c) => {
  try {
    return c.json({ move: (await cancelMove(c.req.param("sessionId"))) ?? null });
  } catch (error) {
    return reply(c, error);
  }
});
