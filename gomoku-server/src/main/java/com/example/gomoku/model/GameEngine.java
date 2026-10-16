package com.example.gomoku.model;

import java.util.ArrayList;
import java.util.List;

/**
 * 五子棋核心规则：无禁手自由局，横 / 竖 / 两条斜线任意方向连成 5 子即胜。
 * <p>
 * 棋盘用 int 二维数组表示：0 = 空，1 = 黑（seat 0），2 = 白（seat 1）。
 */
public final class GameEngine {

    public static final int SIZE = 15;
    /** 连成几子算胜 */
    public static final int WIN_COUNT = 5;

    private static final int[][] DIRECTIONS = {
            {0, 1},   // 横
            {1, 0},   // 竖
            {1, 1},   // 主对角
            {1, -1}   // 副对角
    };

    private GameEngine() {
    }

    public static boolean inBounds(int row, int col) {
        return row >= 0 && row < SIZE && col >= 0 && col < SIZE;
    }

    /**
     * 以 (row, col) 为落点判断是否形成连珠。
     *
     * @return 若获胜，返回构成连珠的所有坐标（长度 >= 5）；否则返回空列表
     */
    public static List<int[]> findWinLine(int[][] board, int row, int col) {
        if (!inBounds(row, col)) {
            return List.of();
        }
        int stone = board[row][col];
        if (stone == 0) {
            return List.of();
        }
        for (int[] dir : DIRECTIONS) {
            List<int[]> line = new ArrayList<>();
            line.add(new int[]{row, col});
            for (int step = 1; step < WIN_COUNT; step++) {
                int r = row + dir[0] * step;
                int c = col + dir[1] * step;
                if (inBounds(r, c) && board[r][c] == stone) {
                    line.add(new int[]{r, c});
                } else {
                    break;
                }
            }
            for (int step = 1; step < WIN_COUNT; step++) {
                int r = row - dir[0] * step;
                int c = col - dir[1] * step;
                if (inBounds(r, c) && board[r][c] == stone) {
                    line.add(0, new int[]{r, c});
                } else {
                    break;
                }
            }
            if (line.size() >= WIN_COUNT) {
                return line;
            }
        }
        return List.of();
    }
}
