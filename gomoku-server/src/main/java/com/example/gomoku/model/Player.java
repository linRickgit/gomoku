package com.example.gomoku.model;

/**
 * 房间内的一个座位。
 * <p>
 * seat 0 = 房主（执黑先行），seat 1 = 对手（执白）。
 */
public class Player {

    private final int seat;
    private final String nickname;
    /** 客户端凭证，WebSocket 握手时携带，用于绑定座位。座位被接管时可替换 */
    private volatile String token;
    private volatile boolean online;
    /** 最近一次断开时间戳，在线时为 0 */
    private volatile long offlineSince;
    /**
     * 座位已被认领但 WebSocket 还没建立。
     * 用于防止刚接管的座位在握手完成前被下一个进来的人再抢一次。
     */
    private volatile boolean claimed;
    /**
     * 持有者是主动离开的（点了「离开」），不是意外掉线。
     * 主动让位不享受掉线保护期，座位立即对外开放。
     */
    private volatile boolean departed;

    public Player(int seat, String nickname, String token) {
        this.seat = seat;
        this.nickname = nickname;
        this.token = token;
        this.online = false;
        // 建位即视为"从未上线"：若客户端拿了凭证却始终没连 WebSocket，
        // 座位会在重连窗口过后释放，不会永久占位
        this.offlineSince = System.currentTimeMillis();
    }

    /** 座位被他人接管时换发凭证，原持有者的凭证随之失效 */
    public void rebindToken(String newToken) {
        this.token = newToken;
        // 换了人就是新的一局关系，之前的"主动离开"标记不再适用
        this.departed = false;
    }

    public int seat() {
        return seat;
    }

    public String nickname() {
        return nickname;
    }

    public String token() {
        return token;
    }

    public boolean isOnline() {
        return online;
    }

    public void setOnline(boolean online) {
        this.online = online;
        if (online) {
            this.departed = false;
            this.offlineSince = 0L;
        } else {
            this.offlineSince = System.currentTimeMillis();
        }
    }

    /**
     * 主动离开：标记离线，并且不进入掉线保护期。
     * 掉线是意外（给几秒缓冲等重连），主动离开是明确让位，没必要再等。
     */
    public void markDeparted() {
        this.online = false;
        this.departed = true;
        this.offlineSince = System.currentTimeMillis();
    }

    /** 是否为主动离开（区别于意外掉线） */
    public boolean isDeparted() {
        return departed;
    }

    public long offlineSince() {
        return offlineSince;
    }

    public boolean isClaimed() {
        return claimed;
    }

    public void setClaimed(boolean claimed) {
        this.claimed = claimed;
    }

    /** 该座位对应的棋子：seat 0 -> 1(黑)，seat 1 -> 2(白) */
    public int stone() {
        return seat + 1;
    }
}
