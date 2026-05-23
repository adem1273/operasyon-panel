import { Body, Controller, Headers, Post, Req } from "@nestjs/common";
import { Request } from "express";
import { AuthService } from "./auth.service";
import { LoginDto } from "./dto/login.dto";
import { RefreshDto } from "./dto/refresh.dto";
import { Public } from "../../common/auth/public.decorator";

type TokenPairResponse = {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
};

@Controller("auth")
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post("login")
  @Public()
  login(@Body() dto: LoginDto, @Req() req: Request): Promise<TokenPairResponse> {
    return this.authService.login({
      email: dto.email,
      password: dto.password,
      ipAddress: req.ip,
      userAgent: req.header("user-agent")
    });
  }

  @Post("refresh")
  @Public()
  refresh(@Body() dto: RefreshDto, @Req() req: Request): Promise<TokenPairResponse> {
    return this.authService.refresh({
      refreshToken: dto.refreshToken,
      ipAddress: req.ip,
      userAgent: req.header("user-agent")
    });
  }

  @Post("logout")
  logout(@Headers("authorization") authorization?: string): Promise<{ success: boolean }> {
    return this.authService.logout(authorization);
  }
}
