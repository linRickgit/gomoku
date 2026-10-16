package com.example.gomoku.controller;

import com.example.gomoku.dto.JoinResponse;
import com.example.gomoku.exception.BizException;
import com.example.gomoku.model.Room;
import com.example.gomoku.service.RoomManager;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

@RestController
@RequestMapping("/api/rooms")
public class RoomController {

    private final RoomManager roomManager;

    public RoomController(RoomManager roomManager) {
        this.roomManager = roomManager;
    }

    /**
     * 建房：无需登录，昵称由服务端随机分配。房主固定执黑先行。
     */
    @PostMapping
    public JoinResponse create() {
        Room room = roomManager.create();
        return new JoinResponse(room.code(), 0, room.player(0).token(), room.player(0).nickname());
    }

    /**
     * 凭 6 位房间码进入。请求体可带 {@code token}，用于断线重连时坐回原座位。
     * <p>
     * 分配优先级：凭证命中 → 对手位空缺 → 接管离线超时的座位 → 观战者（seat -1）。
     */
    @PostMapping("/{code}/join")
    public JoinResponse join(@PathVariable String code,
                             @RequestBody(required = false) Map<String, String> body) {
        String token = body == null ? null : body.get("token");
        RoomManager.JoinResult result = roomManager.join(code, token);
        return new JoinResponse(result.room().code(), result.seat(), result.token(), result.nickname());
    }

    /**
     * 观战者尝试入座。进来时若恰好撞上对方掉线的保护期，会被先安排为观战，
     * 客户端周期性调用本接口，保护期一过即可自动坐上，无需刷新页面。
     * <p>
     * 返回的 seat 仍为 -1 表示暂时没有位子，可以稍后重试。
     */
    @PostMapping("/{code}/seat")
    public JoinResponse claimSeat(@PathVariable String code,
                                  @RequestBody(required = false) Map<String, String> body) {
        String token = body == null ? null : body.get("token");
        RoomManager.JoinResult result = roomManager.claimSeat(code, token);
        return new JoinResponse(result.room().code(), result.seat(), result.token(), result.nickname());
    }

    /**
     * 主动离开房间。与直接关页面的区别在于：座位立即释放，不进入掉线保护期，
     * 别人可以马上进来接着下。
     */
    @PostMapping("/{code}/leave")
    public Map<String, Object> depart(@PathVariable String code,
                                      @RequestBody(required = false) Map<String, String> body) {
        String token = body == null ? null : body.get("token");
        roomManager.depart(code, token);
        return Map.of("left", true);
    }

    /** 进入房间前先探一下房间是否还在、是否已满 */
    @GetMapping("/{code}")
    public Map<String, Object> peek(@PathVariable String code) {
        Room room = roomManager.get(code);
        if (room == null) {
            throw new BizException("ROOM_NOT_FOUND", "房间不存在或已解散");
        }
        return Map.of(
                "code", room.code(),
                "status", room.status().name(),
                "playerCount", room.player(1) == null ? 1 : 2,
                "spectatorCount", room.spectatorCount()
        );
    }

    /** 健康检查 / 观测当前房间数 */
    @GetMapping("/stats")
    public Map<String, Object> stats() {
        return Map.of("roomCount", roomManager.roomCount());
    }
}
