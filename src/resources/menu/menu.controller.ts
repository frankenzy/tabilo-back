import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags, PartialType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsBase64, IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength,
} from 'class-validator';
import { CurrentScope, RequirePermissions } from '../../commons/decorators';
import type { Scope } from '../../commons/types';
import { CATEGORY_ICONS } from './category-icons';
import { MenuService } from './menu.service';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class MenuCategoryDto {
  @ApiProperty() @Transform(trim) @IsString() @MinLength(1) @MaxLength(40)
  name: string;

  @ApiPropertyOptional({ enum: CATEGORY_ICONS, description: 'Pictogramme de la rubrique (spec 003)' })
  @IsOptional() @IsIn([...CATEGORY_ICONS])
  icon?: string;
}

export class UpdateMenuCategoryDto {
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @MinLength(1) @MaxLength(40)
  name?: string;

  @ApiPropertyOptional({ enum: CATEGORY_ICONS }) @IsOptional() @IsIn([...CATEGORY_ICONS])
  icon?: string;
}

export class MenuOrderDto {
  @ApiProperty({ type: [String], description: 'Liste complète des identifiants actifs, dans le nouvel ordre' })
  @IsArray() @ArrayMaxSize(500) @IsUUID('all', { each: true })
  ids: string[];
}

export class CreateMenuItemDto {
  @ApiProperty() @IsUUID()
  categoryId: string;

  @ApiProperty() @Transform(trim) @IsString() @MinLength(1) @MaxLength(60)
  name: string;

  @ApiPropertyOptional({ nullable: true }) @IsOptional() @Transform(trim) @IsString() @MaxLength(200)
  description?: string | null;

  @ApiProperty({ description: 'Prix en unité mineure de la devise (1 500 F CFA = 1500 ; 8,50 € = 850)' })
  @IsInt() @Min(0) @Max(100_000_000)
  priceMinor: number;

  @ApiPropertyOptional({ description: 'false = en rupture' }) @IsOptional() @IsBoolean()
  isAvailable?: boolean;
}

export class UpdateMenuItemDto extends PartialType(CreateMenuItemDto) {}

export class MenuImageDto {
  @ApiProperty({ enum: ['image/jpeg', 'image/png', 'image/webp'] }) @IsIn(['image/jpeg', 'image/png', 'image/webp'])
  mime: string;

  @ApiProperty({ description: 'Contenu en base64, 300 Ko au plus une fois décodé' })
  @IsBase64() @MaxLength(420_000)
  data: string;
}

@ApiTags('Carte')
@ApiBearerAuth()
@Controller({ path: 'establishments/:establishmentId/menu', version: '1' })
export class MenuController {
  constructor(private readonly menu: MenuService) {}

  @Get()
  @RequirePermissions('requests.read')
  @ApiOperation({ summary: 'Carte complète : rubriques et articles' })
  overview(@CurrentScope() scope: Scope) {
    return this.menu.overview(scope.establishmentId);
  }

  @Post('categories')
  @RequirePermissions('menu.manage')
  createCategory(@CurrentScope() scope: Scope, @Body() dto: MenuCategoryDto) {
    return this.menu.createCategory(scope, dto);
  }

  @Put('categories/order')
  @RequirePermissions('menu.manage')
  @ApiOperation({ summary: 'Réordonner les rubriques' })
  reorderCategories(@CurrentScope() scope: Scope, @Body() dto: MenuOrderDto) {
    return this.menu.reorderCategories(scope, dto.ids);
  }

  @Put('categories/:id/items/order')
  @RequirePermissions('menu.manage')
  @ApiOperation({ summary: "Réordonner les articles d'une rubrique" })
  reorderItems(@CurrentScope() scope: Scope, @Param('id', ParseUUIDPipe) id: string, @Body() dto: MenuOrderDto) {
    return this.menu.reorderItems(scope, id, dto.ids);
  }

  @Patch('categories/:id')
  @RequirePermissions('menu.manage')
  updateCategory(@CurrentScope() scope: Scope, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateMenuCategoryDto) {
    return this.menu.updateCategory(scope, id, dto);
  }

  @Delete('categories/:id')
  @HttpCode(204)
  @RequirePermissions('menu.manage')
  archiveCategory(@CurrentScope() scope: Scope, @Param('id', ParseUUIDPipe) id: string) {
    return this.menu.archiveCategory(scope, id);
  }

  @Put('categories/:id/image')
  @RequirePermissions('menu.manage')
  @ApiOperation({ summary: "Remplacer la photo d'une rubrique (remplace son pictogramme côté client)" })
  setCategoryImage(@CurrentScope() scope: Scope, @Param('id', ParseUUIDPipe) id: string, @Body() dto: MenuImageDto) {
    return this.menu.setCategoryImage(scope, id, dto);
  }

  @Delete('categories/:id/image')
  @RequirePermissions('menu.manage')
  removeCategoryImage(@CurrentScope() scope: Scope, @Param('id', ParseUUIDPipe) id: string) {
    return this.menu.removeCategoryImage(scope, id);
  }

  @Post('items')
  @RequirePermissions('menu.manage')
  createItem(@CurrentScope() scope: Scope, @Body() dto: CreateMenuItemDto) {
    return this.menu.createItem(scope, dto);
  }

  @Patch('items/:id')
  @RequirePermissions('menu.manage')
  updateItem(@CurrentScope() scope: Scope, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateMenuItemDto) {
    return this.menu.updateItem(scope, id, dto);
  }

  @Delete('items/:id')
  @HttpCode(204)
  @RequirePermissions('menu.manage')
  archiveItem(@CurrentScope() scope: Scope, @Param('id', ParseUUIDPipe) id: string) {
    return this.menu.archiveItem(scope, id);
  }

  @Put('items/:id/image')
  @RequirePermissions('menu.manage')
  @ApiOperation({ summary: "Remplacer la photo d'un article" })
  setImage(@CurrentScope() scope: Scope, @Param('id', ParseUUIDPipe) id: string, @Body() dto: MenuImageDto) {
    return this.menu.setImage(scope, id, dto);
  }

  @Delete('items/:id/image')
  @RequirePermissions('menu.manage')
  removeImage(@CurrentScope() scope: Scope, @Param('id', ParseUUIDPipe) id: string) {
    return this.menu.removeImage(scope, id);
  }
}
