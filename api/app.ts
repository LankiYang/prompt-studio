/**
 * This is a API server
 */

import 'dotenv/config'
import express, { type Request, type Response } from 'express'
import cors from 'cors'
import authRoutes from './routes/auth.js'
import studioRoutes from './routes/studio.js'

const app: express.Application = express()

app.use(cors())
app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true, limit: '10mb' }))

/**
 * API Routes
 */
app.use('/api/auth', authRoutes)
app.use('/api/studio', studioRoutes)

/**
 * health
 */
app.use(
  '/api/health',
  (_req: Request, res: Response): void => {
    res.status(200).json({
      success: true,
      message: 'ok',
    })
  },
)

/**
 * error handler middleware
 */
app.use((error: Error, _req: Request, res: Response, _next: unknown) => {
  const status = /权限|未激活/.test(error.message) ? 403 : 500
  if (status >= 500) console.error('[API] request failed:', error)
  res.status(status).json({
    success: false,
    error: process.env.NODE_ENV === 'production' ? 'Server internal error' : error.message,
  })
})

/**
 * 404 handler
 */
app.use((_req: Request, res: Response) => {
  res.status(404).json({
    success: false,
    error: 'API not found',
  })
})

export default app
