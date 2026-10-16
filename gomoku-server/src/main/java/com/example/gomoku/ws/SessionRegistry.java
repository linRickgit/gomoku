package com.example.gomoku.ws;

import tools.jackson.databind.ObjectMapper;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.IntFunction;

/**
 * 维护 WebSocket 会话到「房间 + 座位」的绑定，并负责消息下发。
 * <p>
 * 同一个 WebSocketSession 不能被多线程并发写，因此发送时以 session 为锁串行化。
 */
@Component
public class SessionRegistry {

    private final Map<String, WebSocketSession> sessions = new ConcurrentHashMap<>();
    private final Map<String, SessionBinding> bindings = new ConcurrentHashMap<>();
    private final ObjectMapper objectMapper;

    public SessionRegistry(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
    }

    public void bind(WebSocketSession session, String code, int seat) {
        sessions.put(session.getId(), session);
        bindings.put(session.getId(), new SessionBinding(code, seat));
    }

    public SessionBinding unbind(String sessionId) {
        sessions.remove(sessionId);
        return bindings.remove(sessionId);
    }

    public SessionBinding binding(String sessionId) {
        return bindings.get(sessionId);
    }

    public List<String> sessionIdsOfRoom(String code) {
        List<String> ids = new ArrayList<>();
        bindings.forEach((sessionId, binding) -> {
            if (binding.code().equals(code)) {
                ids.add(sessionId);
            }
        });
        return ids;
    }

    public void send(String sessionId, WsMessage message) {
        WebSocketSession session = sessions.get(sessionId);
        if (session == null || !session.isOpen()) {
            return;
        }
        send(session, message);
    }

    public void broadcast(String code, WsMessage message) {
        for (String sessionId : sessionIdsOfRoom(code)) {
            send(sessionId, message);
        }
    }

    /**
     * 按每个会话自己的座位号生成消息再广播。
     * 互换阵营后 seat 会变，客户端需要靠 payload 里的 isSelf 重新确认自己的身份，
     * 所以不能像普通广播那样共用一份不带 isSelf 的快照。
     */
    public void broadcastPerSeat(String code, IntFunction<Object> payloadOf) {
        bindings.forEach((sessionId, binding) -> {
            if (binding.code().equals(code)) {
                send(sessionId, WsMessage.of("room_state", payloadOf.apply(binding.seat())));
            }
        });
    }

    /**
     * 互换阵营后把房间内两个座位的会话绑定对调，
     * 否则玩家的 seat 还停留在旧的号码上，会以对方的身份落子。
     */
    public void swapSeats(String code) {
        bindings.forEach((sessionId, binding) -> {
            if (!binding.code().equals(code)) {
                return;
            }
            if (binding.seat() == 0 || binding.seat() == 1) {
                bindings.put(sessionId, new SessionBinding(code, 1 - binding.seat()));
            }
        });
    }

    /** 只发给房间内的某一个座位 */
    public void sendToSeat(String code, int seat, WsMessage message) {
        bindings.forEach((sessionId, binding) -> {
            if (binding.code().equals(code) && binding.seat() == seat) {
                send(sessionId, message);
            }
        });
    }

    /**
     * 该座位是否还有其他会话。刷新页面时旧连接可能比新连接更晚收到关闭事件，
     * 用它避免旧会话把座位重新标记成离线。
     */
    public boolean hasOtherSession(String code, int seat, String excludeSessionId) {
        for (Map.Entry<String, SessionBinding> entry : bindings.entrySet()) {
            if (entry.getKey().equals(excludeSessionId)) {
                continue;
            }
            SessionBinding binding = entry.getValue();
            if (binding.code().equals(code) && binding.seat() == seat) {
                return true;
            }
        }
        return false;
    }

    /**
     * 关闭同一座位上的其他会话。座位被重新绑定时调用，
     * 保证一个座位只保留最新的一条连接，旧连接不会再收到广播。
     */
    public void closeOthersOfSeat(String code, int seat, String keepSessionId) {
        for (String sessionId : sessionIdsOfRoom(code)) {
            if (sessionId.equals(keepSessionId)) {
                continue;
            }
            SessionBinding binding = bindings.get(sessionId);
            if (binding != null && binding.seat() == seat) {
                close(sessionId);
            }
        }
    }

    public void close(String sessionId) {
        WebSocketSession session = sessions.remove(sessionId);
        bindings.remove(sessionId);
        if (session != null && session.isOpen()) {
            try {
                session.close();
            } catch (IOException ignored) {
                // 关闭失败无需处理，会话会在容器侧超时回收
            }
        }
    }

    private void send(WebSocketSession session, WsMessage message) {
        try {
            String json = objectMapper.writeValueAsString(message);
            synchronized (session) {
                session.sendMessage(new TextMessage(json));
            }
        } catch (IOException e) {
            // 发送失败交给心跳 / 传输错误回调处理
        }
    }
}
