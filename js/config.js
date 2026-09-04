/* ============================================
   云念AI - TRTC 通话配置
   ============================================ */

// 腾讯云 TRTC 配置
// SDKAppID 可以公开（仅用于标识应用）
// SecretKey 绝不能出现在前端代码中，只配置在云函数的环境变量里
const TRTC_CONFIG = {
  sdkAppId: 1600160855,

  // UserSig 签发服务地址（腾讯云函数 URL）
  // 部署完 cloud-function 目录里的云函数后，把函数 URL 填到这里，例如：
  //   'https://1234567890-ap-guangzhou.tencentscf.com/'
  // 部署前保持为空字符串，通话页面会给出提示
  userSigServer: ''
};
