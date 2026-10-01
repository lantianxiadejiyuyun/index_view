export type SessionUser = {
  id: number
  username: string
}

export type AppEnv = {
  Variables: {
    /** requireAuth 中间件注入；仅在受保护路由上存在 */
    user: SessionUser
  }
}
