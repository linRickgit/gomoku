package com.example.gomoku.service;

import com.example.gomoku.dto.PlayerState;
import com.example.gomoku.dto.RoomState;
import com.example.gomoku.exception.BizException;
import com.example.gomoku.model.Player;
import com.example.gomoku.model.Room;
import com.example.gomoku.model.Spectator;
import com.example.gomoku.ws.SessionRegistry;
import com.example.gomoku.ws.WsMessage;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

import java.security.SecureRandom;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;

/**
 * 房间仓库。全部驻留内存（无数据库），因此服务只能单实例部署，
 * 多副本负载均衡会导致同一房间的两名玩家落到不同 JVM 上。
 */
@Service
public class RoomManager {

    private static final SecureRandom RANDOM = new SecureRandom();
    private static final int CODE_SPACE = 1_000_000;
    private static final int MAX_CODE_RETRY = 20;

    private final ConcurrentMap<String, Room> rooms = new ConcurrentHashMap<>();
    private final SessionRegistry sessionRegistry;
    private final NicknameGenerator nicknameGenerator;

    /** 双方都掉线后，棋盘保留多久再回收 */
    private final long abandonedTimeoutMillis;
    /** 玩家掉线后座位的独占保护期，窗口内别人抢不走 */
    private final long seatReserveMillis;

    public RoomManager(SessionRegistry sessionRegistry,
                       NicknameGenerator nicknameGenerator,
                       @Value("${gomoku.room.abandoned-timeout-minutes:10}") long abandonedTimeoutMinutes,
                       @Value("${gomoku.room.seat-reserve-seconds:5}") long seatReserveSeconds) {
        this.sessionRegistry = sessionRegistry;
        this.nicknameGenerator = nicknameGenerator;
        this.abandonedTimeoutMillis = abandonedTimeoutMinutes * 60_000L;
        this.seatReserveMillis = seatReserveSeconds * 1_000L;
    }

    /** 进入房间的结果：seat 为 0/1 是对局者，-1 是观战者 */
    public record JoinResult(Room room, int seat, String token, String nickname) {
    }

    /** 建房：房主固定坐 seat 0，执黑先行 */
    public Room create() {
        String code = generateCode();
        Room room = new Room(code, nicknameGenerator.generate(), UUID.randomUUID().toString());
        rooms.put(code, room);
        return room;
    }

    /**
     * 凭房间码进入，按以下优先级分配身份：
     * <ol>
     *   <li>携带的凭证属于本房间某个座位 → 回到原座位（同一浏览器刷新后再进）</li>
     *   <li>有空位（座位没人，或座位上的人已离线）→ 直接坐下接着下</li>
     *   <li>两个座位都有人在线 → 观战者（seat -1）</li>
     * </ol>
     *
     * @param code  6 位房间码
     * @param token 上次进入时拿到的凭证，可为 null
     */
    public JoinResult join(String code, String token) {
        String normalized = normalizeCode(code);
        Room room = rooms.get(normalized);
        if (room == null) {
            throw new BizException("ROOM_NOT_FOUND", "房间不存在或已解散");
        }

        // 1. 老玩家回来：凭证还有效就直接坐回原位（不受保护期影响）
        Player reconnected = room.reconnect(token);
        if (reconnected != null) {
            return new JoinResult(room, reconnected.seat(), reconnected.token(), reconnected.nickname());
        }

        String newToken = UUID.randomUUID().toString();
        String nickname = nicknameGenerator.generate();

        // 2. 有空位就坐下（离线且过了保护期的座位视为空位）
        Player player = room.joinAsPlayer(nickname, newToken, seatReserveMillis);
        if (player != null) {
            return new JoinResult(room, player.seat(), newToken, player.nickname());
        }

        // 3. 两个座位都有人在线，或恰好卡在掉线保护期里，只能观战
        Spectator spectator = room.joinAsSpectator(nickname, newToken);
        return new JoinResult(room, -1, newToken, spectator.nickname());
    }

    /**
     * 观战者尝试入座：房间里有可接管的座位时就转为对局者，凭证沿用观战时的那张。
     * <p>
     * 客户端在观战状态下可以周期性重试，这样「进来时刚好撞上保护期」的人
     * 等窗口过去就能自动坐上，不需要手动刷新页面。
     *
     * @return seat 仍为 -1 表示暂时还没位子，可以稍后再试
     */
    public JoinResult claimSeat(String code, String token) {
        String normalized = normalizeCode(code);
        Room room = rooms.get(normalized);
        if (room == null) {
            throw new BizException("ROOM_NOT_FOUND", "房间不存在或已解散");
        }
        if (token == null || token.isBlank()) {
            throw new BizException("TOKEN_REQUIRED", "缺少房间凭证，请重新进入");
        }

        // 已经是本房间的对局者了（比如刷新后凭证还在），直接返回原座位
        Player seated = room.reconnect(token);
        if (seated != null) {
            return new JoinResult(room, seated.seat(), seated.token(), seated.nickname());
        }

        Spectator spectator = room.spectator(token);
        if (spectator == null) {
            throw new BizException("NOT_IN_ROOM", "你不在这个房间里");
        }

        Player promoted = room.promoteSpectator(token, seatReserveMillis);
        if (promoted == null) {
            return new JoinResult(room, -1, token, spectator.nickname());
        }
        // 入座后立刻同步一次，让房间内其他人看到新玩家
        broadcastState(room);
        return new JoinResult(room, promoted.seat(), promoted.token(), promoted.nickname());
    }

    /**
     * 主动离开房间：座位立即释放，不享受掉线保护期。
     * <p>
     * 掉线是意外，值得等几秒看人会不会回来；主动点「离开」是明确让位，
     * 再占着 5 秒只会挡住想进来的人。观战者走同一接口，从观战列表里摘掉。
     */
    public void depart(String code, String token) {
        String normalized = normalizeCode(code);
        Room room = rooms.get(normalized);
        if (room == null) {
            throw new BizException("ROOM_NOT_FOUND", "房间不存在或已解散");
        }
        if (token == null || token.isBlank()) {
            throw new BizException("TOKEN_REQUIRED", "缺少房间凭证");
        }

        int seat = room.seatOf(token);
        if (seat >= 0) {
            room.depart(seat);
            broadcastState(room);
            return;
        }
        if (room.spectator(token) != null) {
            room.removeSpectator(token);
            broadcastState(room);
            return;
        }
        throw new BizException("NOT_IN_ROOM", "你不在这个房间里");
    }

    public Room get(String code) {
        return code == null ? null : rooms.get(normalizeCode(code));
    }

    public int roomCount() {
        return rooms.size();
    }

    /** 解散房间，并通知房间内所有连接 */
    public void destroy(String code) {
        Room room = rooms.remove(code);
        if (room == null) {
            return;
        }
        sessionRegistry.broadcast(code, WsMessage.of("room_closed", Map.of("reason", "房间已解散")));
        for (String sessionId : sessionRegistry.sessionIdsOfRoom(code)) {
            sessionRegistry.unbind(sessionId);
        }
    }

    /** 生成 6 位数字房间码，冲突自动重试 */
    private String generateCode() {
        for (int i = 0; i < MAX_CODE_RETRY; i++) {
            String code = String.format("%06d", RANDOM.nextInt(CODE_SPACE));
            if (!rooms.containsKey(code)) {
                return code;
            }
        }
        throw new BizException("CODE_EXHAUSTED", "房间码生成失败，请稍后重试");
    }

    private String normalizeCode(String code) {
        String trimmed = code == null ? "" : code.trim();
        if (!trimmed.matches("\\d{6}")) {
            throw new BizException("INVALID_CODE", "房间码必须是 6 位数字");
        }
        return trimmed;
    }

    /**
     * 定时巡检，回收没人要的房间。
     * <p>
     * 规则：只要还有玩家在线就一直保留（对局中绝不能被回收打断）；
     * 双方都掉线后，棋盘再保留一段时间（默认 10 分钟）等人回来，超时才销毁。
     * 还有观战者挂着时暂缓回收 —— 说明仍有人在关注这盘棋。
     */
    @Scheduled(fixedDelayString = "${gomoku.sweep-interval-millis:60000}",
               initialDelayString = "${gomoku.sweep-initial-delay-millis:60000}")
    public void sweep() {
        long now = System.currentTimeMillis();
        for (Room room : rooms.values()) {
            if (hasOnlinePlayer(room)) {
                room.touch();
                continue;
            }
            if (room.spectatorCount() > 0) {
                continue;
            }
            if (now - room.lastActivityAt() > abandonedTimeoutMillis) {
                destroy(room.code());
            }
        }
    }

    private boolean hasOnlinePlayer(Room room) {
        for (int seat = 0; seat < 2; seat++) {
            Player player = room.player(seat);
            if (player != null && player.isOnline()) {
                return true;
            }
        }
        return false;
    }

    // ---------- 状态快照与广播 ----------

    /**
     * 向房间内所有人（含观战者）广播最新状态。
     * 每个会话收到的快照都带上自己的 isSelf 标记：互换阵营后座位号会变，
     * 客户端需要据此重新确认"我现在是哪一个"。
     */
    public void broadcastState(Room room) {
        sessionRegistry.broadcastPerSeat(room.code(), seat -> snapshot(room, seat));
    }

    /** 只给指定座位下发状态（用于补发，含 isSelf 标记） */
    public void sendStateTo(Room room, int seat) {
        sessionRegistry.sendToSeat(room.code(), seat, WsMessage.of("room_state", snapshot(room, seat)));
    }

    public static RoomState snapshot(Room room, int selfSeat) {
        PlayerState[] players = new PlayerState[2];
        for (int seat = 0; seat < 2; seat++) {
            Player player = room.player(seat);
            if (player == null) {
                players[seat] = null;
            } else {
                Boolean isSelf = selfSeat < 0 ? null : (selfSeat == seat);
                players[seat] = new PlayerState(seat, player.nickname(), player.isOnline(), isSelf);
            }
        }
        int[][] winLine = room.winLine().stream().map(int[]::clone).toArray(int[][]::new);
        return new RoomState(
                room.code(),
                room.status().name(),
                room.turn(),
                room.boardSnapshot(),
                players,
                room.winnerSeat(),
                room.endReason().name(),
                winLine,
                room.moves().size(),
                room.rematchVotes().clone(),
                room.lastMove(),
                room.undoRequestFrom(),
                room.swapRequestFrom(),
                room.spectatorCount()
        );
    }
}
