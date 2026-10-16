package com.example.gomoku.ws;

/** WebSocket 会话与房间座位的绑定关系 */
public record SessionBinding(String code, int seat) {
}
