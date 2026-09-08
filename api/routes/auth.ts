import { Router, type Request, type Response } from 'express';
import type { StudioCreateAccountInput } from '../../shared/studio-types.js';
import { getStudioRepository } from '../services/studio-repository.js';

const router = Router();

function accessToken(req: Request) {
  const value = req.header('authorization');
  return value?.startsWith('Bearer ') ? value.slice('Bearer '.length).trim() : undefined;
}

function authenticated(req: Request, res: Response) {
  const session = getStudioRepository().authenticate(accessToken(req));
  if (session) return session;
  res.status(401).json({ success: false, error: '登录已失效，请重新登录' });
  return null;
}

router.get('/bootstrap', (_req, res) => {
  res.json(getStudioRepository().getAuthBootstrap());
});

router.post('/setup', (req, res, next) => {
  try {
    res.status(201).json(getStudioRepository().setupInitialOwner(req.body ?? {}));
  } catch (error) {
    next(error);
  }
});

router.post('/login', (req, res, next) => {
  try {
    res.json(getStudioRepository().login(req.body?.username, req.body?.password));
  } catch (error) {
    next(error);
  }
});

router.get('/me', (req, res) => {
  const session = authenticated(req, res);
  if (session) res.json({ expiresAt: session.expiresAt, member: session.member });
});

router.post('/logout', (req, res) => {
  getStudioRepository().logout(accessToken(req));
  res.status(204).end();
});

router.post('/accounts', (req, res, next) => {
  try {
    const session = authenticated(req, res);
    if (!session) return;
    const projectId = typeof req.body?.projectId === 'string'
      ? req.body.projectId
      : getStudioRepository().getProject().id;
    const actor = getStudioRepository().assertProjectPermission(projectId, session.member.id, ['owner']);
    res.status(201).json(getStudioRepository().createAccount(req.body as StudioCreateAccountInput, actor));
  } catch (error) {
    next(error);
  }
});

export default router;
