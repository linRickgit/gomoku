package com.example.gomoku.dto;

import com.fasterxml.jackson.annotation.JsonInclude;

@JsonInclude(JsonInclude.Include.NON_NULL)
/**
 * @param isSelf 广播给房间所有人时为 null；单独下发给本人时为 true，下发给对手时为 false
 */
public record PlayerState(int seat, String nickname, boolean online, Boolean isSelf) {
}
