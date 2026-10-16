package com.example.gomoku.model;

import java.util.List;

/**
 * 落子执行结果。落子合法性校验与胜负判定都在服务端完成，前端结果不可信。
 */
public record MoveResult(boolean success, String message, List<int[]> winLine) {

    public static MoveResult ok(List<int[]> winLine) {
        return new MoveResult(true, null, winLine == null ? List.of() : winLine);
    }

    public static MoveResult fail(String message) {
        return new MoveResult(false, message, List.of());
    }
}
