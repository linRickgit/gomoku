package com.example.gomoku.model;

/**
 * 对局结束原因。
 * <p>
 * 掉线不会自动判负：玩家掉线后棋盘原地保留等待重连，
 * 只有房间长时间无活动才会被回收。
 */
public enum EndReason {
    NONE,
    /** 五子连珠 */
    FIVE_IN_ROW,
    /** 认输 */
    RESIGN,
    /** 棋盘下满，和棋 */
    DRAW
}
