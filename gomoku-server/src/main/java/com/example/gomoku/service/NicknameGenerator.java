package com.example.gomoku.service;

import org.springframework.stereotype.Component;

import java.security.SecureRandom;

/**
 * 随机昵称生成器。无登录体系，进入房间时自动分配一个中文昵称。
 */
@Component
public class NicknameGenerator {

    private static final String[] PREFIX = {
            "沉稳", "凌厉", "从容", "机敏", "老练", "灵动", "锐利", "内敛",
            "洒脱", "缜密", "果敢", "飘逸", "稳健", "刁钻", "淡定", "锋芒"
    };

    private static final String[] SUFFIX = {
            "棋手", "弈者", "观棋客", "落子人", "黑白客", "棋士", "布局者", "对弈者",
            "纵横家", "点星人", "连珠客", "守拙者", "抢先手", "收官人", "隐士", "过客"
    };

    private static final SecureRandom RANDOM = new SecureRandom();

    public String generate() {
        String prefix = PREFIX[RANDOM.nextInt(PREFIX.length)];
        String suffix = SUFFIX[RANDOM.nextInt(SUFFIX.length)];
        return prefix + "的" + suffix;
    }
}
