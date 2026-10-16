package com.example.gomoku;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.scheduling.annotation.EnableScheduling;

@EnableScheduling
@SpringBootApplication
public class GomokuApplication {

    public static void main(String[] args) {
        SpringApplication.run(GomokuApplication.class, args);
    }
}
