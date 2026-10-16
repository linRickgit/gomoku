package com.example.gomoku.model;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 一个对局房间。完全驻留内存，服务重启即丢失。
 * <p>
 * 所有会改变对局状态的方法都加了 synchronized：落子、认输、悔棋、再来一局
 * 都会同时来自多个 WebSocket 线程，必须以房间为单位串行化。
 */
public class Room {

    private final String code;
    private final Player[] players = new Player[2];
    private final Map<String, Spectator> spectators = new ConcurrentHashMap<>();
    private final int[][] board = new int[GameEngine.SIZE][GameEngine.SIZE];
    private final List<Move> moves = new ArrayList<>();
    private final boolean[] rematchVotes = new boolean[2];
    private final long createdAt = System.currentTimeMillis();

    private volatile GameStatus status = GameStatus.WAITING;
    private volatile EndReason endReason = EndReason.NONE;
    /** 获胜座位号；和棋时为 null */
    private volatile Integer winnerSeat;
    private volatile List<int[]> winLine = List.of();
    /** 当前该谁落子（座位号） */
    private volatile int turn = 0;
    /** 谁发起了悔棋请求，null 表示无待处理请求 */
    private volatile Integer undoRequestFrom;
    /** 谁发起了互换阵营请求，null 表示无待处理请求 */
    private volatile Integer swapRequestFrom;
    private volatile long lastActivityAt = System.currentTimeMillis();

    public Room(String code, String hostNickname, String hostToken) {
        this.code = code;
        this.players[0] = new Player(0, hostNickname, hostToken);
    }

    public String code() {
        return code;
    }

    public long createdAt() {
        return createdAt;
    }

    public long lastActivityAt() {
        return lastActivityAt;
    }

    public GameStatus status() {
        return status;
    }

    public EndReason endReason() {
        return endReason;
    }

    public Integer winnerSeat() {
        return winnerSeat;
    }

    public List<int[]> winLine() {
        return winLine;
    }

    public int turn() {
        return turn;
    }

    public Integer undoRequestFrom() {
        return undoRequestFrom;
    }

    public Integer swapRequestFrom() {
        return swapRequestFrom;
    }

    public List<Move> moves() {
        return List.copyOf(moves);
    }

    public Player player(int seat) {
        return players[seat];
    }

    public Player[] players() {
        return players;
    }

    public boolean[] rematchVotes() {
        return rematchVotes;
    }

    public int spectatorCount() {
        return spectators.size();
    }

    public Spectator spectator(String token) {
        return spectators.get(token);
    }

    /** 返回棋盘副本，避免内部数组被外部修改 */
    public int[][] boardSnapshot() {
        int[][] copy = new int[GameEngine.SIZE][GameEngine.SIZE];
        for (int i = 0; i < GameEngine.SIZE; i++) {
            System.arraycopy(board[i], 0, copy[i], 0, GameEngine.SIZE);
        }
        return copy;
    }

    public void touch() {
        this.lastActivityAt = System.currentTimeMillis();
    }

    // ---------- 进入房间 ----------

    /**
     * 作为对局者加入：有空位就直接坐，没空位才返回 null（由上层降级为观战）。
     * <p>
     * 「空位」的判定是：座位没人，或者座位上的人已离线。
     * 掉线不再长期占位 —— 玩家中途退出后，下一个人进来就能接着下这盘棋。
     *
     * @param reserveMillis 座位持有者掉线后的独占保护期，窗口内不接受接管
     * @return 加入成功返回座位对象；两个座位都有人在线时返回 null
     */
    public synchronized Player joinAsPlayer(String nickname, String token, long reserveMillis) {
        if (players[1] == null) {
            Player player = new Player(1, nickname, token);
            players[1] = player;
            status = GameStatus.PLAYING;
            turn = 0;
            touch();
            return player;
        }
        return claimOfflineSeat(token, reserveMillis);
    }

    /**
     * 接管一个已经离线的座位，优先对手位。
     * 棋盘、轮次、历史落子全部保留，新人接着原来的局面下。
     * 昵称沿用原座位：对手视角里"坐在对面的还是那个人"，不会凭空换人。
     * <p>
     * 刚掉线时座位有一段独占保护期，窗口内不接受接管 —— 给网络抖动留出缓冲，
     * 避免玩家断线一瞬间座位就被路过的第三人抢走。原持有者本人凭凭证回来不受此限。
     *
     * @return 接管成功返回座位对象；没有可接管的座位返回 null
     */
    private synchronized Player claimOfflineSeat(String token, long reserveMillis) {
        long now = System.currentTimeMillis();
        for (int seat = 1; seat >= 0; seat--) {
            Player player = players[seat];
            if (player == null || player.isOnline() || player.isClaimed()) {
                continue;
            }
            // 主动离开的人没有保护期，座位立即对外开放
            if (!player.isDeparted() && now - player.offlineSince() < reserveMillis) {
                continue;
            }
            player.rebindToken(token);
            player.setOnline(false);
            // 握手完成前锁住座位，避免被紧接着进来的下一个人再抢走
            player.setClaimed(true);
            touch();
            return player;
        }
        return null;
    }

    /**
     * 观战者尝试补位：有可接管的座位就转成对局者，凭证沿用观战时的那张。
     * <p>
     * 用于「进来时正好赶上对手掉线保护期，只能先观战」的场景：
     * 客户端可以稍后重试，窗口一过就自动入座，不需要刷新页面。
     *
     * @return 入座成功返回座位对象；保护期内或无空位返回 null（仍是观战者）
     */
    public synchronized Player promoteSpectator(String token, long reserveMillis) {
        Spectator spectator = spectators.get(token);
        if (spectator == null) {
            return null;
        }
        Player player = claimOfflineSeat(token, reserveMillis);
        if (player == null) {
            return null;
        }
        spectators.remove(token);
        touch();
        return player;
    }

    /** 作为观战者加入，房间已满时使用 */
    public synchronized Spectator joinAsSpectator(String nickname, String token) {
        Spectator spectator = new Spectator(nickname, token);
        spectators.put(token, spectator);
        touch();
        return spectator;
    }

    /**
     * 凭凭证回到原来的座位（断线重连 / 刷新页面后再进入）。
     *
     * @return 命中座位则返回该座位对象；凭证无效或不属于本房间时返回 null
     */
    public synchronized Player reconnect(String token) {
        int seat = seatOf(token);
        if (seat < 0) {
            return null;
        }
        touch();
        return players[seat];
    }

    /** 凭证属于本房间哪个座位；不属于任何座位（含空凭证）时返回 -1 */
    public synchronized int seatOf(String token) {
        if (token == null || token.isBlank()) {
            return -1;
        }
        for (int seat = 0; seat < 2; seat++) {
            Player player = players[seat];
            if (player != null && player.token().equals(token)) {
                return seat;
            }
        }
        return -1;
    }

    /**
     * 主动离开：立刻释放座位，不进入掉线保护期。
     * 与掉线的唯一区别就在这里 —— 掉线是意外，给几秒缓冲；主动离开是明确让位。
     */
    public synchronized void depart(int seat) {
        Player player = players[seat];
        if (player == null) {
            return;
        }
        player.markDeparted();
        // 人走了，挂着的请求自然作废
        undoRequestFrom = null;
        swapRequestFrom = null;
        touch();
    }


    public synchronized void removeSpectator(String token) {
        spectators.remove(token);
        touch();
    }

    public synchronized boolean isFull() {
        return players[0] != null && players[1] != null;
    }

    /** 校验 token 是否属于该房间的指定座位 */
    public boolean authenticate(int seat, String token) {
        Player player = players[seat];
        return player != null && player.token().equals(token);
    }

    /**
     * 执行一次落子，并同步完成胜负判定。
     */
    public synchronized MoveResult place(int seat, int row, int col) {
        if (status != GameStatus.PLAYING) {
            return MoveResult.fail("对局未开始或已结束");
        }
        if (turn != seat) {
            return MoveResult.fail("还没轮到你落子");
        }
        if (!GameEngine.inBounds(row, col)) {
            return MoveResult.fail("坐标超出棋盘范围");
        }
        if (board[row][col] != 0) {
            return MoveResult.fail("这个位置已经有棋子了");
        }

        board[row][col] = seat + 1;
        moves.add(new Move(seat, row, col, moves.size()));
        // 一旦落子，挂着的悔棋 / 换阵营请求就没意义了
        undoRequestFrom = null;
        swapRequestFrom = null;

        List<int[]> line = GameEngine.findWinLine(board, row, col);
        if (!line.isEmpty()) {
            status = GameStatus.FINISHED;
            endReason = EndReason.FIVE_IN_ROW;
            winnerSeat = seat;
            winLine = line;
            touch();
            return MoveResult.ok(line);
        }
        if (moves.size() == GameEngine.SIZE * GameEngine.SIZE) {
            status = GameStatus.FINISHED;
            endReason = EndReason.DRAW;
            winnerSeat = null;
            touch();
            return MoveResult.ok(List.of());
        }

        turn = 1 - seat;
        touch();
        return MoveResult.ok(List.of());
    }

    /** 认输，对手直接获胜 */
    public synchronized boolean resign(int seat) {
        if (status != GameStatus.PLAYING) {
            return false;
        }
        finish(1 - seat, EndReason.RESIGN);
        return true;
    }

    private void finish(int winner, EndReason reason) {
        status = GameStatus.FINISHED;
        endReason = reason;
        winnerSeat = winner;
        winLine = List.of();
        rematchVotes[0] = false;
        rematchVotes[1] = false;
        undoRequestFrom = null;
        swapRequestFrom = null;
        touch();
    }

    // ---------- 悔棋 ----------

    /** 发起悔棋请求，等对方回应 */
    public synchronized boolean requestUndo(int seat) {
        if (moves.isEmpty()) {
            return false;
        }
        undoRequestFrom = seat;
        // 悔棋与换阵营共用一个"待对手处理"的位置，避免同时挂着两个请求
        swapRequestFrom = null;
        touch();
        return true;
    }

    public synchronized void clearUndoRequest() {
        undoRequestFrom = null;
        touch();
    }

    /** 发起互换阵营请求，等对方回应 */
    public synchronized boolean requestSwap(int seat) {
        if (status != GameStatus.PLAYING) {
            return false;
        }
        if (players[0] == null || players[1] == null) {
            return false;
        }
        swapRequestFrom = seat;
        undoRequestFrom = null;
        touch();
        return true;
    }

    public synchronized void clearSwapRequest() {
        swapRequestFrom = null;
        touch();
    }

    /**
     * 互换阵营：两人交换黑白，棋盘上已有的棋子颜色跟着翻转，回合也翻转。
     * <p>
     * 等价于两人换边继续下同一盘棋——局面不变，只是执棋颜色互换。
     * 历史落子的归属也要同步翻转，否则悔棋会撤回对手的棋子。
     *
     * @return 交换成功返回 true
     */
    public synchronized boolean swapSides() {
        if (players[0] == null || players[1] == null) {
            return false;
        }
        Player black = players[0];
        Player white = players[1];
        players[0] = new Player(0, white.nickname(), white.token());
        players[1] = new Player(1, black.nickname(), black.token());
        players[0].setOnline(white.isOnline());
        players[1].setOnline(black.isOnline());

        for (int r = 0; r < GameEngine.SIZE; r++) {
            for (int c = 0; c < GameEngine.SIZE; c++) {
                if (board[r][c] == 1) {
                    board[r][c] = 2;
                } else if (board[r][c] == 2) {
                    board[r][c] = 1;
                }
            }
        }

        List<Move> swapped = new ArrayList<>(moves.size());
        for (Move move : moves) {
            swapped.add(new Move(1 - move.seat(), move.row(), move.col(), move.index()));
        }
        moves.clear();
        moves.addAll(swapped);

        turn = 1 - turn;
        undoRequestFrom = null;
        swapRequestFrom = null;
        rematchVotes[0] = false;
        rematchVotes[1] = false;
        touch();
        return true;
    }

    /**
     * 执行悔棋：回退到「又轮到 seat 落子」为止。
     * <p>
     * 典型情况是撤销两手（对手的应手 + 自己想收回的那手）；
     * 盘面不足两手时退化为撤销一手。悔棋不限次数。
     *
     * @return 撤销成功返回 true
     */
    public synchronized boolean undo(int seat) {
        if (moves.isEmpty()) {
            return false;
        }
        int rollback = Math.min(2, moves.size());
        for (int i = 0; i < rollback; i++) {
            Move last = moves.remove(moves.size() - 1);
            board[last.row()][last.col()] = 0;
        }

        // 悔棋后重新回到对局中（可能是在终局后收回致败的一手）
        status = GameStatus.PLAYING;
        endReason = EndReason.NONE;
        winnerSeat = null;
        winLine = List.of();
        rematchVotes[0] = false;
        rematchVotes[1] = false;
        undoRequestFrom = null;
        swapRequestFrom = null;
        turn = seat;
        touch();
        return true;
    }

    // ---------- 再来一局 ----------

    /**
     * 申请再来一局。双方都同意后才真正重置棋盘。
     *
     * @return true 表示本回合棋盘已重置
     */
    public synchronized boolean requestRematch(int seat) {
        if (status != GameStatus.FINISHED) {
            return false;
        }
        rematchVotes[seat] = true;
        touch();
        if (rematchVotes[0] && rematchVotes[1]) {
            resetBoard();
            return true;
        }
        return false;
    }

    private void resetBoard() {
        for (int[] row : board) {
            Arrays.fill(row, 0);
        }
        moves.clear();
        rematchVotes[0] = false;
        rematchVotes[1] = false;
        status = GameStatus.PLAYING;
        endReason = EndReason.NONE;
        winnerSeat = null;
        winLine = List.of();
        undoRequestFrom = null;
        swapRequestFrom = null;
        // 房主（seat 0）始终执黑先行
        turn = 0;
    }

    /** 最后一手的坐标 [row, col]，尚未落子时为 null */
    public int[] lastMove() {
        if (moves.isEmpty()) {
            return null;
        }
        Move last = moves.get(moves.size() - 1);
        return new int[]{last.row(), last.col()};
    }

    /** 掉线时把座位标记为离线；在线则刷新时间戳 */
    public synchronized void setOnline(int seat, boolean online) {
        Player player = players[seat];
        if (player != null) {
            player.setOnline(online);
            if (online) {
                // 握手完成，解除接管时加的占位锁
                player.setClaimed(false);
            }
        }
        touch();
    }
}
