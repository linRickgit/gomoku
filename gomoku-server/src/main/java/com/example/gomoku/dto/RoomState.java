package com.example.gomoku.dto;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * 房间完整状态快照。每次对局状态发生变化时，服务端都会向房间内所有人广播一份。
 * <p>
 * 这里刻意不使用 NON_NULL：像 undoRequestFrom、winnerSeat、lastMove 这些字段
 * 为 null 时是有语义的（"没有待处理请求" / "和棋" / "还没落子"），
 * 一旦被省略，前端拿到的是 undefined，null 判断就会失效。
 */
@JsonInclude(JsonInclude.Include.ALWAYS)
public record RoomState(
        String code,
        String status,
        int turn,
        int[][] board,
        PlayerState[] players,
        Integer winnerSeat,
        String endReason,
        int[][] winLine,
        int moveCount,
        boolean[] rematchVotes,
        /** 最后一手坐标 [row, col]，用于前端标记最新落子 */
        int[] lastMove,
        /** 谁在等待对方同意悔棋，null 表示没有待处理请求 */
        Integer undoRequestFrom,
        /** 谁在等待对方同意互换阵营，null 表示没有待处理请求 */
        Integer swapRequestFrom,
        /** 当前观战人数 */
        int spectatorCount
) {
}
