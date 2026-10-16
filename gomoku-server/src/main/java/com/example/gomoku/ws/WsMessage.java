package com.example.gomoku.ws;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * WebSocket 统一消息信封：{"type":"...", "payload":{...}}
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record WsMessage(String type, Object payload) {

    public static WsMessage of(String type) {
        return new WsMessage(type, null);
    }

    public static WsMessage of(String type, Object payload) {
        return new WsMessage(type, payload);
    }
}
