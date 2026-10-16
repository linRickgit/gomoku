package com.example.gomoku.ws;

import com.example.gomoku.model.Room;
import com.example.gomoku.service.RoomManager;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.TextWebSocketHandler;

import java.io.IOException;
import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;

/**
 * 对局 WebSocket 端点：/ws/game?code=123456&token=xxx
 * <p>
 * 所有落子都必须经过这里：服务端校验轮次、坐标合法性并做胜负判定，
 * 前端只负责发送意图和渲染结果。
 */
@Component
public class GameWebSocketHandler extends TextWebSocketHandler {

    /** 座位号：0 = 房主（黑），1 = 对手（白），-1 = 观战者，小于 -1 = 凭证无效 */
    private static final int SEAT_SPECTATOR = -1;
    private static final int SEAT_INVALID = -2;

    private final RoomManager roomManager;
    private final SessionRegistry sessionRegistry;
    private final ObjectMapper objectMapper;

    public GameWebSocketHandler(RoomManager roomManager,
                                SessionRegistry sessionRegistry,
                                ObjectMapper objectMapper) {
        this.roomManager = roomManager;
        this.sessionRegistry = sessionRegistry;
        this.objectMapper = objectMapper;
    }

    @Override
    public void afterConnectionEstablished(WebSocketSession session) throws IOException {
        String code = queryParam(session, "code");
        String token = queryParam(session, "token");

        Room room = roomManager.get(code);
        if (room == null) {
            reject(session, "ROOM_NOT_FOUND", "房间不存在或已解散");
            return;
        }
        int seat = resolveSeat(room, token);
        if (seat == SEAT_INVALID) {
            reject(session, "INVALID_TOKEN", "凭证无效");
            return;
        }

        sessionRegistry.bind(session, room.code(), seat);
        boolean spectator = seat == SEAT_SPECTATOR;
        if (!spectator) {
            room.setOnline(seat, true);
            // 刷新页面重连时，旧连接可能还没被服务端感知，这里主动清掉，
            // 保证一个座位只有一条活跃连接
            sessionRegistry.closeOthersOfSeat(room.code(), seat, session.getId());
        }

        Map<String, Object> welcome = new HashMap<>();
        welcome.put("code", room.code());
        welcome.put("seat", seat);
        welcome.put("spectator", spectator);
        welcome.put(
                "nickname",
                spectator && room.spectator(token) != null
                        ? room.spectator(token).nickname()
                        : spectator ? "观战者" : room.player(seat).nickname());
        sessionRegistry.send(session.getId(), WsMessage.of("welcome", welcome));

        roomManager.broadcastState(room);
    }

    @Override
    protected void handleTextMessage(WebSocketSession session, TextMessage message) throws IOException {
        SessionBinding binding = sessionRegistry.binding(session.getId());
        if (binding == null) {
            sendError(session.getId(), "会话未绑定房间");
            return;
        }

        JsonNode root = objectMapper.readTree(message.getPayload());
        String type = root.path("type").asText("");
        JsonNode payload = root.path("payload");

        Room room = roomManager.get(binding.code());
        if (room == null) {
            sessionRegistry.send(session.getId(), WsMessage.of("room_closed", Map.of("reason", "房间已解散")));
            return;
        }

        int seat = binding.seat();

        if (seat == SEAT_SPECTATOR) {
            // 观战者只接收广播，任何对局操作都拒绝
            switch (type) {
                case "ping" -> sessionRegistry.send(session.getId(), WsMessage.of("pong"));
                default -> sendError(session.getId(), "观战模式不能参与对局");
            }
            return;
        }

        switch (type) {
            case "move" -> handleMove(session, room, seat, payload);
            case "resign" -> handleResign(room, seat);
            case "rematch" -> handleRematch(room, seat);
            case "undo_request" -> handleUndoRequest(session, room, seat);
            case "undo_response" -> handleUndoResponse(session, room, seat, payload);
            case "swap_request" -> handleSwapRequest(session, room, seat);
            case "swap_response" -> handleSwapResponse(session, room, seat, payload);
            case "ping" -> sessionRegistry.send(session.getId(), WsMessage.of("pong"));
            default -> sendError(session.getId(), "未知的消息类型: " + type);
        }
    }

    private void handleMove(WebSocketSession session, Room room, int seat, JsonNode payload) {
        if (!payload.has("row") || !payload.has("col")) {
            sendError(session.getId(), "缺少落子坐标");
            return;
        }
        int row = payload.path("row").asInt(-1);
        int col = payload.path("col").asInt(-1);

        var result = room.place(seat, row, col);
        if (!result.success()) {
            sendError(session.getId(), result.message());
            // 落子被拒时补发一次状态，纠正前端可能的乐观更新
            roomManager.sendStateTo(room, seat);
            return;
        }
        roomManager.broadcastState(room);
    }

    private void handleResign(Room room, int seat) {
        if (room.resign(seat)) {
            roomManager.broadcastState(room);
        }
    }

    private void handleRematch(Room room, int seat) {
        boolean restarted = room.requestRematch(seat);
        if (restarted) {
            roomManager.broadcastState(room);
        } else {
            sessionRegistry.broadcast(room.code(), WsMessage.of("rematch_pending", Map.of("seat", seat)));
            roomManager.broadcastState(room);
        }
    }

    /** 发起悔棋，等对方点头 */
    private void handleUndoRequest(WebSocketSession session, Room room, int seat) {
        if (!room.requestUndo(seat)) {
            sendError(session.getId(), "当前没有可撤销的落子");
            return;
        }
        roomManager.broadcastState(room);
    }

    /** 对方回应悔棋请求。agree=true 则回退到请求方的回合 */
    private void handleUndoResponse(WebSocketSession session, Room room, int seat, JsonNode payload) {
        Integer requester = room.undoRequestFrom();
        if (requester == null) {
            return;
        }
        if (requester == seat) {
            sendError(session.getId(), "不能响应自己发起的悔棋请求");
            return;
        }
        boolean agree = payload.path("agree").asBoolean(false);
        if (agree) {
            room.undo(requester);
        } else {
            room.clearUndoRequest();
        }
        roomManager.broadcastState(room);
    }

    /** 发起互换阵营，等对方点头 */
    private void handleSwapRequest(WebSocketSession session, Room room, int seat) {
        if (!room.requestSwap(seat)) {
            sendError(session.getId(), "当前不能申请互换阵营");
            return;
        }
        roomManager.broadcastState(room);
    }

    /** 对方回应互换阵营。agree=true 则双方交换黑白，棋局继续 */
    private void handleSwapResponse(WebSocketSession session, Room room, int seat, JsonNode payload) {
        Integer requester = room.swapRequestFrom();
        if (requester == null) {
            return;
        }
        if (requester == seat) {
            sendError(session.getId(), "不能响应自己发起的请求");
            return;
        }
        boolean agree = payload.path("agree").asBoolean(false);
        if (agree) {
            room.swapSides();
            // 座位对调后，已建立的连接也要跟着换绑，否则会以对方的身份落子
            sessionRegistry.swapSeats(room.code());
        } else {
            room.clearSwapRequest();
        }
        roomManager.broadcastState(room);
    }

    @Override
    public void afterConnectionClosed(WebSocketSession session, CloseStatus status) {
        SessionBinding binding = sessionRegistry.unbind(session.getId());
        if (binding == null) {
            return;
        }
        Room room = roomManager.get(binding.code());
        if (room == null) {
            return;
        }
        if (binding.seat() == SEAT_SPECTATOR) {
            // 观战者离开后不再保留，避免空观战位一直挂着
            String token = queryParam(session, "token");
            if (token != null) {
                room.removeSpectator(token);
            }
        } else if (binding.seat() >= 0) {
            // 掉线只标记离线并广播，不判负：棋盘原地保留等待重连。
            // 若该座位已有新连接（刷新重连），旧会话的关闭不能覆盖在线状态
            if (!sessionRegistry.hasOtherSession(room.code(), binding.seat(), session.getId())) {
                room.setOnline(binding.seat(), false);
            }
        }
        roomManager.broadcastState(room);
    }

    @Override
    public void handleTransportError(WebSocketSession session, Throwable exception) {
        // 传输错误最终会触发 afterConnectionClosed，那里统一处理离线
    }

    private int resolveSeat(Room room, String token) {
        if (token == null || token.isBlank()) {
            return SEAT_INVALID;
        }
        for (int seat = 0; seat < 2; seat++) {
            if (room.authenticate(seat, token)) {
                return seat;
            }
        }
        return room.spectator(token) != null ? SEAT_SPECTATOR : SEAT_INVALID;
    }

    private void sendError(String sessionId, String message) {
        sessionRegistry.send(sessionId, WsMessage.of("error", Map.of("message", message)));
    }

    private void reject(WebSocketSession session, String errorCode, String message) throws IOException {
        sessionRegistry.send(session.getId(), WsMessage.of("error",
                Map.of("code", errorCode, "message", message, "fatal", true)));
        session.close(CloseStatus.POLICY_VIOLATION.withReason(message));
    }

    private String queryParam(WebSocketSession session, String name) {
        URI uri = session.getUri();
        if (uri == null || uri.getQuery() == null) {
            return null;
        }
        for (String pair : uri.getQuery().split("&")) {
            String[] kv = pair.split("=", 2);
            if (kv.length == 2 && kv[0].equals(name)) {
                return URLDecoder.decode(kv[1], StandardCharsets.UTF_8);
            }
        }
        return null;
    }
}
