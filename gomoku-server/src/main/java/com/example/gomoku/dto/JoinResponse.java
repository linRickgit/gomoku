package com.example.gomoku.dto;

/**
 * 建房 / 加入房间成功后返回给前端的凭证。
 * token 用于 WebSocket 握手时绑定座位，相当于一个极简的匿名身份。
 */
public record JoinResponse(String code, int seat, String token, String nickname) {
}
