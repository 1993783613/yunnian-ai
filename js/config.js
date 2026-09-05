/* ============================================
   云念AI - TRTC 通话配置
   ============================================ */

// 腾讯云 TRTC 配置
// SDKAppID 可以公开（仅用于标识应用）
// SecretKey 绝不能出现在前端代码中，只配置在云函数的环境变量里
const TRTC_CONFIG = {
  sdkAppId: 1600160855,

  // UserSig 签发服务地址（腾讯云函数）
  // 已部署并验证通过
  userSigServer: 'https://1422484427-kxu5p373mj.ap-guangzhou.tencentscf.com/'
};
